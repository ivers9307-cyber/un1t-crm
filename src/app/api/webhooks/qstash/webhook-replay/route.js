// QSTASH.3 — push-delivery worker for webhook_dead_letter replays.
//
// QStash POSTs { id } here (published fire-and-forget by
// deadLetterWebhook right after a replayable provider's dead-letter
// insert, with a 60s Upstash-Delay), signed with an Upstash-Signature
// JWT. We verify the signature, re-fetch the row, and run it through the
// SAME claim CAS the replay cron uses (src/lib/webhook-replay-queue.js)
// — the two consumers race safely; whoever claims first wins and the
// other sees `skipped`.
//
// Status-code contract with QStash retries:
//   200 — done (replayed, or someone else already handled the row)
//   401 — signature rejected (not retryable-by-us; QStash will retry,
//         and each retry re-verifies — a rotated key heals this)
//   500 — replay failed; replayDeadLetter has already bumped attempts +
//         last_attempt_at, QStash retries with ITS backoff — which
//         replaces the cron's exponential backoff for pushed rows.
//
// The dead-letter table stays the source of truth throughout — rows
// whose QStash retries are exhausted stay 'pending' for the cron
// sweeper, and QStash going away entirely (env vars unset) reverts
// cleanly to cron-only replays.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyQStashSignature, WEBHOOK_REPLAY_WORKER_PATH } from '@/lib/qstash'
import {
  claimAndReplayDeadLetterRow,
  MAX_ATTEMPTS,
  REPLAYABLE_PROVIDERS,
} from '@/lib/webhook-replay-queue'
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
    expectedUrl = `${getAppUrl()}${WEBHOOK_REPLAY_WORKER_PATH}`
  } catch {
    // NEXT_PUBLIC_APP_URL unset — verify everything else but skip the
    // sub check rather than rejecting deliveries over our own config.
    console.error('[qstash webhook-replay worker] NEXT_PUBLIC_APP_URL unset; skipping sub-claim check')
  }

  const verdict = verifyQStashSignature({
    signature: request.headers.get('upstash-signature'),
    rawBody,
    url: expectedUrl || undefined,
  })
  if (!verdict.ok) {
    console.warn(`[qstash webhook-replay worker] delivery rejected: ${verdict.reason}`)
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
  // replayable provider, within the retry budget. An already-resolved,
  // discarded or exhausted row is a clean 200 skip — QStash must not
  // redeliver it. (No backoff check here: for pushed rows the 60s
  // publish delay + QStash's own retry schedule replace the cron's
  // exponential backoff.)
  const { data: rows, error: fetchErr } = await db
    .from('webhook_dead_letter')
    .select('id, provider, payload, status, attempts, last_attempt_at')
    .eq('id', id)
    .eq('status', 'pending')
    .in('provider', REPLAYABLE_PROVIDERS)
    .lt('attempts', MAX_ATTEMPTS)
    .limit(1)

  if (fetchErr) {
    console.error('[qstash webhook-replay worker] row fetch failed:', fetchErr.message)
    return NextResponse.json({ success: false, error: fetchErr.message }, { status: 500 })
  }

  const row = rows?.[0]
  if (!row) {
    return NextResponse.json({ success: true, skipped: true })
  }

  const outcome = await claimAndReplayDeadLetterRow(db, row)
  if (outcome.status === 'failed') {
    console.warn(
      `[qstash webhook-replay worker] row ${row.id} (${row.provider}) failed (attempt ${(row.attempts || 1) + 1}): ${outcome.error}`
    )
  }
  const { status, body } = responseForOutcome(outcome)
  return NextResponse.json(body, { status })
}
