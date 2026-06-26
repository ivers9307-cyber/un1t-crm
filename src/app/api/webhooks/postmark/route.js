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
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'

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

  // Idempotency (mig 107). Same dedup as before — short-circuits
  // duplicate Postmark retries BEFORE queueing so we don't enqueue
  // the same event twice.
  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.POSTMARK,
    eventId: `${recordType}:${messageId}`,
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  // Park the raw payload. Cron drains. Returning 200 fast keeps
  // Vercel's request rate happy under bursts and prevents
  // Postmark from retrying on a flaky outage.
  const { error } = await db.from('postmark_webhook_queue').insert({ payload: body })
  if (error) {
    console.error('[postmark webhook] queue insert failed:', error.message)
    await deadLetterWebhook(db, {
      provider: 'postmark',
      eventType: recordType,
      payload: body,
      error,
    })
    // Return 200 so Postmark does not retry-storm us while the queue table is
    // unavailable — the dead-letter row keeps the event visible for ops.
    return NextResponse.json({ success: true, status: 'queue_failed_dead_lettered' })
  }

  return NextResponse.json({ success: true, queued: true })
}
