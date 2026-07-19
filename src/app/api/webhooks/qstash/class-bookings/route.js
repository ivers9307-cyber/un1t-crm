// QSTASH.7 — push-delivery worker for the class_booking_requests queue.
//
// QStash POSTs { id } here (published fire-and-forget by
// /api/public/class-booking and the WhatsApp Flow completion handler
// right after their queue inserts), signed with an Upstash-Signature
// JWT. We verify the signature, re-fetch the row, and run it through
// the SAME claim CAS the process-class-bookings cron uses
// (src/lib/class-booking-queue.js) — the two consumers race safely;
// whoever claims first wins and the other sees `skipped`.
//
// Status-code contract with QStash retries — mirrors the cron's failure
// bookkeeping exactly:
//   200 — done. Every decision-tree RETURN is terminal (booked, routed
//         to staff review, or terminally failed — the processor stamps
//         the row itself), so a QStash retry cannot improve it; and
//         `skipped` means someone else already owns the row.
//   401 — signature rejected (not retryable-by-us; QStash will retry,
//         and each retry re-verifies — a rotated key heals this)
//   500 — the processor THREW. The shared lib already did the cron's
//         bookkeeping: under the attempt cap the row was RE-QUEUED, so
//         QStash's redelivery finds it 'queued' and re-runs it — the
//         same later-tick retry the cron has always done, just sooner.
//         At the cap the row went 'needs_review' and the redelivery
//         200-skips.
//
// The class_booking_requests table stays the source of truth throughout
// — QStash going away entirely (env vars unset) reverts cleanly to
// cron-only processing, and the cron's reaper (CRON-ONLY, unchanged)
// still recovers rows a crashed invocation left in 'processing'.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyQStashSignature, CLASS_BOOKINGS_WORKER_PATH } from '@/lib/qstash'
import { claimAndProcessBookingJob, MAX_ATTEMPTS } from '@/lib/class-booking-queue'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // same budget as the cron — the Glofox call chain can crawl

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
    expectedUrl = `${getAppUrl()}${CLASS_BOOKINGS_WORKER_PATH}`
  } catch {
    // NEXT_PUBLIC_APP_URL unset — verify everything else but skip the
    // sub check rather than rejecting deliveries over our own config.
    console.error('[qstash class-bookings worker] NEXT_PUBLIC_APP_URL unset; skipping sub-claim check')
  }

  const verdict = verifyQStashSignature({
    signature: request.headers.get('upstash-signature'),
    rawBody,
    url: expectedUrl || undefined,
  })
  if (!verdict.ok) {
    console.warn(`[qstash class-bookings worker] delivery rejected: ${verdict.reason}`)
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

  // Same eligibility as the cron's oldest-queued select: 'queued' only.
  // An already-claimed ('processing'), booked, needs_review or failed
  // row is a clean 200 skip — QStash must not redeliver it. attempts <
  // MAX_ATTEMPTS is belt-and-braces (every requeue path caps attempts,
  // so a queued row past the cap shouldn't exist; if one ever does the
  // cron — whose select has no attempts filter — remains the catch-all).
  // Full row: the shared lib passes it to the decision-tree processor.
  const { data: rows, error: fetchErr } = await db
    .from('class_booking_requests')
    .select('*')
    .eq('id', id)
    .eq('status', 'queued')
    .lt('attempts', MAX_ATTEMPTS)
    .limit(1)

  if (fetchErr) {
    console.error('[qstash class-bookings worker] row fetch failed:', fetchErr.message)
    return NextResponse.json({ success: false, error: fetchErr.message }, { status: 500 })
  }

  const job = rows?.[0]
  if (!job) {
    return NextResponse.json({ success: true, skipped: true })
  }

  const outcome = await claimAndProcessBookingJob(db, job)
  if (outcome.status === 'failed') {
    console.warn(`[qstash class-bookings worker] request ${job.id} threw: ${outcome.error}`)
  }
  const { status, body } = responseForOutcome(outcome)
  return NextResponse.json(body, { status })
}
