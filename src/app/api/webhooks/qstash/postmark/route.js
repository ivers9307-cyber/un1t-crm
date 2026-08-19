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
import { verifyQStashSignature, POSTMARK_WORKER_PATH } from '@/lib/qstash'
import { claimAndProcessQueueRow, MAX_ATTEMPTS } from '@/lib/postmark-queue'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
  // looked. The queue row is back to pending with attempts+1, so the sweeper
  // cron re-runs it ~10 minutes from now — comfortably past the worst commit
  // lag ever measured on prod (13.2s across 3,231 samples). 200, not 500:
  // QStash's own retries fire within seconds and would burn the retry budget
  // inside the very window they cannot outrun. Nothing is lost by retiring the
  // QStash message — the queue table has always been the delivery guarantee
  // here, and QStash only ever the latency optimisation.
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
      'send row not committed yet; the sweeper cron will retry it.'
    )
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
