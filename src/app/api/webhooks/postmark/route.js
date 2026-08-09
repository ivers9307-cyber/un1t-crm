// Postmark webhook handler — CAMPAIGN.13 refactor.
//
// Previously this handler did 3-5 sequential DB writes per event,
// inline. With ~5,000 webhooks firing in 20s after the "15 mins?"
// send, Vercel hit a lambda concurrency / request-rate limit and
// many webhooks 5xx'd before reaching our code. The "Massive
// burst… 8x faster failures… no error logs… platform/validation
// level" alert was the signal.
//
// New shape:
//   1. Auth check (shared-secret header — unchanged).
//   2. Dedup by (RecordType + MessageID).
//   3. INSERT raw payload into postmark_webhook_queue.
//   4. Return 200.
//
// The cron at /api/cron/process-postmark-webhooks drains the
// queue and runs the actual per-event work via
// src/lib/postmark-webhook-processor.js. Same semantics, async.
//
// Why this is safe under load:
//   - 1 INSERT vs ~5 reads+writes per event = ~10x faster handler.
//   - No per-row transaction contention on hot tables (email_sends,
//     campaigns) during a burst — those writes serialise through
//     the cron at a controllable rate.
//   - Idempotency preserved by recordWebhookEvent dedup BEFORE
//     queueing, so even if Postmark retries we don't queue twice.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifySharedSecret } from '@/lib/webhook-auth'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { deadLetterWebhook, resolveEmailSendLocation } from '@/lib/webhook-dead-letter'
import { publishQueuePush, POSTMARK_WORKER_PATH } from '@/lib/qstash'

// Force Node.js runtime so node:crypto is available for the timing-safe compare.
export const runtime = 'nodejs'

/**
 * Pure auth-gate predicate, exported so the route test can exercise enforcement
 * without standing up a full request fixture.
 */
export function verifyPostmarkRequest({ headerValue, primarySecret, previousSecret }) {
  if (!primarySecret) {
    return { ok: false, status: 500, reason: 'missing_secret' }
  }
  if (!headerValue) {
    return { ok: false, status: 403, reason: 'missing_header' }
  }

  const primary = verifySharedSecret(headerValue, primarySecret)
  if (primary.ok) return { ok: true, matched: 'primary' }

  if (previousSecret) {
    const previous = verifySharedSecret(headerValue, previousSecret)
    if (previous.ok) return { ok: true, matched: 'previous' }
  }

  return { ok: false, status: 403, reason: 'token_mismatch' }
}

/**
 * COMMSFIX.C.2 — build the idempotency key for one Postmark event.
 *
 * `${RecordType}:${MessageID}` is stable for the lifetime of a message, so the
 * mig 107 dedup layer did not merely drop Postmark's retries — it dropped every
 * genuine repeat event, permanently. Prod: 927 multi-open sends in May 2026
 * (pre-deploy) against ZERO in June/July/August across ~6,200 opened sends.
 * Second clicks (even on a different link) and second bounces went the same way.
 *
 * A retry redelivers the IDENTICAL payload, so keying on a per-event field that
 * Postmark itself sets keeps retries deduped while letting real repeats through:
 *   • Open / Click  → ReceivedAt (per-event timestamp).
 *   • Bounce        → Postmark's per-bounce `ID`.
 *   • Delivery      → unchanged; one message delivers once.
 *   • SubscriptionChange → unchanged when bound to a message. Postmark-side
 *     suppressions (bulk import, manual) carry the ZERO GUID as MessageID, so
 *     every one of them collided on a single key and only the first ever landed
 *     — those get the recipient appended.
 *
 * Counter idempotency is the processor's job and already holds: FirstOpen gates
 * total_opened, the status guards gate the rest, and COMMSFIX.C.1 put
 * total_delivered on the delivered_at transition.
 *
 * Exported for unit test (src/lib/postmark-webhook-dedup.test.js).
 */
export function buildWebhookEventId(body) {
  const recordType = body?.RecordType || 'unknown'
  const messageId = body?.MessageID
  switch (recordType) {
    case 'Open':
    case 'Click':
      return `${recordType}:${messageId}:${body?.ReceivedAt ?? ''}`
    case 'Bounce':
      return `Bounce:${messageId}:${body?.ID ?? ''}`
    case 'SubscriptionChange':
      return isZeroGuid(messageId)
        ? `SubscriptionChange:${messageId}:${body?.Recipient ?? ''}`
        : `SubscriptionChange:${messageId}`
    default:
      return `${recordType}:${messageId}`
  }
}

function isZeroGuid(messageId) {
  return typeof messageId === 'string' && /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(messageId)
}

export async function POST(request) {
  const auth = verifyPostmarkRequest({
    headerValue: request.headers.get('x-webhook-token'),
    primarySecret: process.env.POSTMARK_WEBHOOK_TOKEN,
    previousSecret: process.env.POSTMARK_WEBHOOK_TOKEN_PREVIOUS,
  })
  if (!auth.ok) {
    if (auth.reason === 'missing_secret') {
      console.error(
        '[security] POSTMARK_WEBHOOK_TOKEN is not set — refusing Postmark webhook ' +
        'with 500 so Postmark retries once the env var is configured.'
      )
    } else {
      console.warn(`[security] Postmark webhook rejected: ${auth.reason}`)
    }
    return NextResponse.json(
      { success: false, error: auth.reason },
      { status: auth.status }
    )
  }
  if (auth.matched === 'previous') {
    console.warn(
      '[security] Postmark webhook accepted via POSTMARK_WEBHOOK_TOKEN_PREVIOUS — ' +
      'finish rotating Postmark custom headers to the new token, then unset PREVIOUS.'
    )
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 })
  }

  const messageId = body?.MessageID
  if (!messageId) {
    return NextResponse.json({ success: false, error: 'Missing MessageID' }, { status: 400 })
  }

  const recordType = body.RecordType || 'unknown'
  const db = createServerClient()

  // Idempotency (mig 107) — short-circuits duplicate Postmark retries BEFORE
  // queueing so we don't enqueue the same event twice. COMMSFIX.C.2 narrowed
  // the key per record type; see buildWebhookEventId above for why.
  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.POSTMARK,
    eventId: buildWebhookEventId(body),
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  // Park the raw payload. Cron drains. Returning 200 fast keeps
  // Vercel's request rate happy under bursts and prevents
  // Postmark from retrying on a flaky outage.
  const { data: queued, error } = await db
    .from('postmark_webhook_queue')
    .insert({ payload: body })
    .select('id')
    .single()
  if (error) {
    console.error('[postmark webhook] queue insert failed:', error.message)
    await deadLetterWebhook(db, {
      provider: 'postmark',
      eventType: recordType,
      payload: body,
      error,
      // DEADLETTER-LOC.1 — best-effort (never throws). The queue insert just
      // failed, so this lookup may fail too; a NULL location still lands and
      // the health pane's NULL-inclusive count catches it.
      locationId: await resolveEmailSendLocation(db, messageId),
    })
    // Return 200 so Postmark does not retry-storm us while the queue table is
    // unavailable — the dead-letter row keeps the event visible for ops.
    return NextResponse.json({ success: true, status: 'queue_failed_dead_lettered' })
  }

  // QSTASH.1 — push delivery. Nudge QStash to deliver this row to the
  // worker route now instead of waiting for the next cron tick. Fire-
  // and-forget: env-gated (no QSTASH_TOKEN → skipped), and any failure
  // leaves the row for the cron — the queue table is the delivery
  // guarantee, QStash is the latency optimisation.
  if (queued?.id) {
    try {
      await publishQueuePush({
        path: POSTMARK_WORKER_PATH,
        body: { id: queued.id },
        // Dash-separated, not colon — QStash's docs never show punctuation
        // beyond dashes in dedup ids, and the first live publish 400'd
        // with a colon in this header (root cause TBC via the body log).
        deduplicationId: `postmark-queue-${queued.id}`,
      })
    } catch {
      // publishQueuePush swallows its own errors; belt-and-braces only.
    }
  }

  return NextResponse.json({ success: true, queued: true })
}
