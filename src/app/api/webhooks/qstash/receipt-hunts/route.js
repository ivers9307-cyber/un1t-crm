// QSTASH.10 — push-delivery worker for the recon_bank_lines
// receipt-hunt queue.
//
// QStash POSTs { id } here — published per seeded row by seedHunts
// (src/lib/recon/statuses.js, run by the Friday receipt-coverage-weekly
// cron) onto the `receipt-hunts` QUEUE with **parallelism 1**, NOT
// plain publish: a hunt opens IMAP sessions against the location's
// operator mailboxes and burns a Claude Vision call per candidate, and
// the cron has always drained this queue strictly sequentially (BATCH
// rows per tick, one at a time). The parallelism-1 queue preserves
// exactly that sequentiality while replacing */5-polling latency with
// continuous drain. Deliveries are signed with an Upstash-Signature
// JWT; we verify, re-fetch the row, and run it through the SAME claim
// semantics as the process-receipt-hunts cron
// (src/lib/recon/hunt-queue.js — by-id CAS mirroring the
// claim_recon_hunt_batch RPC predicate), so the two consumers race
// safely; whoever claims first wins and the other sees `skipped`.
//
// ── FINALIZER IS CRON-ONLY — DO NOT ADD IT HERE ──────────────────────
// This route must NEVER call maybeFinalizeWeekly. The finalizer sends
// the weekly coverage report email and stamps the
// receipt-coverage-weekly heartbeat (ANOTHER cron's heartbeat), and
// its "no report sent yet" guard (reportAlreadySent in
// src/lib/recon/finalize.js) is check-then-act — two concurrent
// callers can both pass it and double-send the email. The cron is the
// single caller, serialized by its own schedule. Worst case with
// QStash draining the queue between ticks: the weekly report waits
// ≤5 min for the next process-receipt-hunts tick. That latency is
// accepted by design. (Same for both heartbeats — the cron stamps its
// own; the finalizer stamps the weekly one; this worker stamps
// nothing.)
//
// Status-code contract with QStash retries:
//   200 — done, for EVERY hunt outcome: found, not_found AND error.
//         huntLine never throws; its bookkeeping is terminal either
//         way — found/not_found flip the line's status and clear the
//         queue flags, and an error routes through errorFinish (a
//         terminal recon_hunts audit row + de-queue WITHOUT touching
//         status). The cron does exactly the same with 'error': it
//         tallies `failed` and never retries — the line waits for next
//         Friday's re-seed. A 500 would make QStash re-deliver work
//         whose outcome is already recorded (the retry would re-fetch,
//         find hunt_queued_at NULL, and skip) — pure retry-budget burn.
//   401 — signature rejected (not retryable-by-us; QStash will retry,
//         and each retry re-verifies — a rotated key heals this)
//   500 — infrastructure error only (row fetch failed) — a QStash
//         retry genuinely helps there.
//
// The recon_bank_lines table stays the source of truth throughout —
// QStash going away entirely (env vars unset) reverts cleanly to
// cron-only processing, and rows QStash misses (incl. the seed-time
// HUNT_PUBLISH_CAP overflow) are swept by the cron's RPC batch claim
// (stale claims re-sweep after 10 minutes).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyQStashSignature, RECEIPT_HUNTS_WORKER_PATH } from '@/lib/qstash'
import { claimAndHuntLine } from '@/lib/recon/hunt-queue'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // same budget as the cron — IMAP round-trips + an LLM call per candidate are slow

/**
 * missing_keys means WE are misconfigured (route reachable but signing keys
 * unset) — 503 flags it as a server problem. Every other reason is a bad
 * or forged delivery — 401.
 */
export function statusForVerifyFailure(reason) {
  return reason === 'missing_keys' ? 503 : 401
}

export function responseForOutcome(outcome) {
  if (outcome.status === 'hunted') {
    // Includes outcome 'error' — terminal, already de-queued by
    // huntLine's errorFinish (see header). Never 500 a hunt outcome.
    return { status: 200, body: { success: true, processed: true, outcome: outcome.outcome } }
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
    expectedUrl = `${getAppUrl()}${RECEIPT_HUNTS_WORKER_PATH}`
  } catch {
    // NEXT_PUBLIC_APP_URL unset — verify everything else but skip the
    // sub check rather than rejecting deliveries over our own config.
    console.error('[qstash receipt-hunts worker] NEXT_PUBLIC_APP_URL unset; skipping sub-claim check')
  }

  const verdict = verifyQStashSignature({
    signature: request.headers.get('upstash-signature'),
    rawBody,
    url: expectedUrl || undefined,
  })
  if (!verdict.ok) {
    console.warn(`[qstash receipt-hunts worker] delivery rejected: ${verdict.reason}`)
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

  // Same eligibility as the RPC's queue predicate: still queued only
  // (status uncovered/not_found + hunt_queued_at set). A line already
  // hunted (submitted / de-queued) is a clean 200 skip — QStash must
  // not redeliver it. Claimed-ness is deliberately NOT filtered here:
  // that is the claim CAS's job (fresh claim → skip; stale claim →
  // crashed consumer, re-claimable). Full row: huntLine needs
  // location_id, line_date, description, amount, hunt_attempts, ….
  const { data: rows, error: fetchErr } = await db
    .from('recon_bank_lines')
    .select('*')
    .eq('id', id)
    .in('status', ['uncovered', 'not_found'])
    .not('hunt_queued_at', 'is', null)
    .limit(1)

  if (fetchErr) {
    console.error('[qstash receipt-hunts worker] row fetch failed:', fetchErr.message)
    return NextResponse.json({ success: false, error: fetchErr.message }, { status: 500 })
  }

  const line = rows?.[0]
  if (!line) {
    return NextResponse.json({ success: true, skipped: true })
  }

  const outcome = await claimAndHuntLine(db, line)
  if (outcome.status === 'hunted' && outcome.outcome === 'error') {
    console.warn(`[qstash receipt-hunts worker] hunt for line ${line.id} errored (recorded + de-queued; next Friday re-seeds)${outcome.reason ? `: ${outcome.reason}` : ''}`)
  }
  const { status, body } = responseForOutcome(outcome)
  return NextResponse.json(body, { status })
}
