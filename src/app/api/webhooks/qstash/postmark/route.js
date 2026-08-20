// QSTASH.1 — push-delivery worker for the postmark_webhook_queue.
//
// QStash POSTs { id } here (published by /api/webhooks/postmark right
// after its queue insert), signed with an Upstash-Signature JWT. We
// verify the signature, re-fetch the row, and run it through the SAME
// claim/process/release CAS the drain cron uses — the two consumers
// race safely; whoever claims first wins and the other sees `skipped`.
//
// Status-code contract with QStash retries:
//   200 — done (processed, or someone else already handled the row)
//   401 — signature rejected (not retryable-by-us; QStash will retry,
//         and each retry re-verifies — a rotated key heals this)
//   500 — processing failed; row released with attempts+1, QStash
//         retries with backoff. The cron remains the sweeper of last
//         resort for rows QStash gives up on (its DLQ notwithstanding).
//
// The queue table stays the source of truth throughout — QStash going
// away entirely (env vars unset) reverts cleanly to cron-only draining.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyQStashSignature, publishQueuePush, POSTMARK_WORKER_PATH } from '@/lib/qstash'
import { claimAndProcessQueueRow, MAX_ATTEMPTS } from '@/lib/postmark-queue'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POSTMARK-RACE.2 — how long to wait before re-running a deferred row.
 *
 * 60s is ~4.5x the worst commit lag ever measured on prod (13.2s over 3,231
 * samples; p50 8.1s, p95 11.3s, nothing beyond 60s). Long enough that QStash's
 * own fast retries — which fire inside the race window and would burn the
 * attempt budget without the row ever having had time to land — are not what
 * is doing the retrying; short enough that recovery is a minute rather than
 * the sweeper's queue.
 */
export const DEFERRED_RETRY_DELAY_SECONDS = 60

/**
 * Dedup id for a deferred row's re-publish.
 *
 * Attempt-scoped ON PURPOSE. The ingest publish uses `postmark-queue-<id>`, so
 * reusing that id would land inside QStash's dedup window and be swallowed —
 * the retry would simply never be delivered, and the row would fall back to the
 * sweeper, which is the latency this exists to remove. (Same trap the
 * host-campaign self-chain hit: an identical-body dedup id breaks the chain.)
 * Dashes only — QStash 400s on a colon in this header.
 */
export function deferredRetryDedupId(rowId, attempts) {
  return `postmark-queue-${rowId}-r${Number(attempts) || 0}`
}

/**
 * Re-publish a deferred row to ourselves with a delay.
 *
 * Fire-and-forget by contract: publishQueuePush never throws and is env-gated
 * on QSTASH_TOKEN, so with QStash unset or down this is a no-op and the sweeper
 * cron remains the delivery guarantee it has always been. Nothing about the
 * queue row depends on it — the row is already back to pending with attempts+1.
 */
export async function scheduleDeferredRetry(rowId, attempts) {
  try {
    await publishQueuePush({
      path: POSTMARK_WORKER_PATH,
      body: { id: rowId },
      deduplicationId: deferredRetryDedupId(rowId, attempts),
      delaySeconds: DEFERRED_RETRY_DELAY_SECONDS,
    })
  } catch {
    // publishQueuePush swallows its own errors; belt-and-braces only.
  }
}

/**
 * missing_keys means WE are misconfigured (route reachable but signing keys
 * unset) — 503 flags it as a server problem. Every other reason is a bad
 * or forged delivery — 401.
 */
export function statusForVerifyFailure(reason) {
  return reason === 'missing_keys' ? 503 : 401
}

export function responseForOutcome(outcome) {
  if (outcome.status === 'processed') {
    return { status: 200, body: { success: true, processed: true } }
  }
  if (outcome.status === 'skipped') {
    return { status: 200, body: { success: true, skipped: true } }
  }
  // POSTMARK-RACE.1 — the event's email_sends row had not committed when we
  // looked. The queue row is back to pending with attempts+1. 200, not 500:
  // QStash's own retries fire within seconds and would burn the retry budget
  // inside the very window they cannot outrun, so this message is retired and
  // a fresh one is published with a 60s delay instead (POSTMARK-RACE.2 —
  // scheduleDeferredRetry above).
  //
  // The original comment here claimed the sweeper cron made this good in ~10
  // minutes. It sized the wait against the commit window and not against the
  // sweeper's THROUGHPUT: BATCH_SIZE 100 every 10 minutes is a hard ceiling of
  // 600 rows/hour, and a prod campaign burst produces ~1,000 raced events at
  // once (peak 1,038 in a single 10-minute window). Measured on 2026-08-10 the
  // cron ran at exactly 100 per tick from 18:10 past 21:40 — hours, not
  // minutes, with one-click unsubscribes and hard bounces sharing that FIFO.
  // The delayed re-publish is what actually makes recovery fast; the sweeper is
  // the guarantee behind it, for a QStash outage.
  if (outcome.status === 'deferred') {
    return { status: 200, body: { success: true, deferred: true } }
  }
  return {
    status: 500,
    body: { success: false, error: outcome.error || 'processing_failed' },
  }
}

export async function POST(request) {
  // Raw body FIRST — the signature's body claim hashes the exact bytes
  // delivered, so any parse-then-restringify would break verification.
  const rawBody = await request.text()

  let expectedUrl = null
  try {
    expectedUrl = `${getAppUrl()}${POSTMARK_WORKER_PATH}`
  } catch {
    // NEXT_PUBLIC_APP_URL unset — verify everything else but skip the
    // sub check rather than rejecting deliveries over our own config.
    console.error('[qstash postmark worker] NEXT_PUBLIC_APP_URL unset; skipping sub-claim check')
  }

  const verdict = verifyQStashSignature({
    signature: request.headers.get('upstash-signature'),
    rawBody,
    url: expectedUrl || undefined,
  })
  if (!verdict.ok) {
    console.warn(`[qstash postmark worker] delivery rejected: ${verdict.reason}`)
    return NextResponse.json(
      { success: false, error: verdict.reason },
      { status: statusForVerifyFailure(verdict.reason) }
    )
  }

  let id
  try {
    id = JSON.parse(rawBody)?.id
  } catch {
    return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 })
  }
  if (!id) {
    return NextResponse.json({ success: false, error: 'missing_id' }, { status: 400 })
  }

  const db = createServerClient()

  // Same eligibility filter as the cron's batch select: pending only,
  // within the retry budget. An already-processed or exhausted row is a
  // clean 200 skip — QStash must not redeliver it.
  const { data: rows, error: fetchErr } = await db
    .from('postmark_webhook_queue')
    .select('id, payload, attempts')
    .eq('id', id)
    .is('processed_at', null)
    .lt('attempts', MAX_ATTEMPTS)
    .limit(1)

  if (fetchErr) {
    console.error('[qstash postmark worker] row fetch failed:', fetchErr.message)
    return NextResponse.json({ success: false, error: fetchErr.message }, { status: 500 })
  }

  const row = rows?.[0]
  if (!row) {
    return NextResponse.json({ success: true, skipped: true })
  }

  const outcome = await claimAndProcessQueueRow(db, row)
  if (outcome.status === 'deferred') {
    console.warn(
      `[qstash postmark worker] event ${row.id} deferred (attempt ${outcome.attempts}) — ` +
      `send row not committed yet; re-publishing with a ${DEFERRED_RETRY_DELAY_SECONDS}s delay.`
    )
    await scheduleDeferredRetry(row.id, outcome.attempts)
  }
  if (outcome.status === 'failed') {
    const attempt = outcome.attempts ?? (row.attempts || 0) + 1
    if (outcome.deadLettered) {
      // POSTMARK-DLQ.1 — this was the attempt that spent the budget. The row
      // is now invisible to the select above (and to the cron), so the
      // payload lives on only in webhook_dead_letter. Still a 500: QStash's
      // retry is harmless (the re-fetch filters the row out and answers 200
      // skipped) and the failure is real.
      console.error(
        `[qstash postmark worker] event ${row.id} EXHAUSTED after ${attempt} attempts ` +
        `— dead-lettered to webhook_dead_letter (provider postmark_queue): ${outcome.error}`
      )
    } else {
      console.warn(
        `[qstash postmark worker] event ${row.id} failed (attempt ${attempt}): ${outcome.error}`
      )
    }
  }
  const { status, body } = responseForOutcome(outcome)
  return NextResponse.json(body, { status })
}
