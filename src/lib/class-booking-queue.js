// Shared class_booking_requests row processing (QSTASH.7).
//
// Extracted verbatim from the process-class-bookings cron's per-row
// loop so the QStash worker route and the cron share ONE
// claim/process/failure implementation — the two consumers can run
// concurrently against the same table precisely because they go
// through this CAS.
//
// Claim semantics: flip status 'queued'→'processing' AND bump attempts
// in one conditional UPDATE, conditioned on status still being 'queued'
// — the same status CAS the cron has always used, keyed by id. Exactly
// one claimant wins; the loser matches 0 rows and skips. The row's
// updated_at trigger refreshes on the claim — that timestamp is what
// the cron's reaper keys its staleness check on.
//
// Failure split (unchanged from the cron):
//   processor RETURNS  → terminal. The decision tree stamps the row
//                        itself (booked / needs_review / failed), so
//                        every returned outcome is 'processed' here —
//                        there is nothing left to retry.
//   processor THROWS   → retryable. Re-queue under MAX_ATTEMPTS, else
//                        flag needs_review for staff. The
//                        .eq('status','processing') guard stops this
//                        ever clobbering a row the processor already
//                        moved to a terminal state.
//
// A consumer that CRASHES mid-run (function timeout, deploy) leaves the
// row in 'processing'; the cron's reaper — deliberately CRON-ONLY —
// re-queues it after its staleness window.

import { processClassBookingRequest } from './class-booking-processor.js'

// Keep in sync with class-booking-processor.js (its routeToReview
// review-unavailable fallback caps on the same number).
export const MAX_ATTEMPTS = 3

/**
 * Claim one queued booking request (status CAS + attempts bump), run it
 * through the decision-tree processor, and do the cron's throw-path
 * failure bookkeeping.
 *
 * @param {SupabaseClient} db — service-role client
 * @param {object} row — a full class_booking_requests row AS FETCHED
 *   (pre-claim attempts — the processor and the bookkeeping both key off
 *   the fetched value, exactly as the cron always has)
 * @returns {Promise<{status: 'processed', outcome: string, detail?: string}
 *   | {status: 'skipped'}
 *   | {status: 'failed', error: string, requeued: boolean}>}
 */
export async function claimAndProcessBookingJob(db, row) {
  const { data: claimed } = await db.from('class_booking_requests')
    .update({ status: 'processing', attempts: (row.attempts || 0) + 1 })
    .eq('id', row.id).eq('status', 'queued').select('id').maybeSingle()
  if (!claimed) return { status: 'skipped' } // lost the race

  try {
    const r = await processClassBookingRequest(db, row)
    return { status: 'processed', outcome: r.outcome, detail: r.detail }
  } catch (e) {
    const error = String(e?.message || e)
    // Retry under the cap, else flag for staff. The status guard stops this
    // ever clobbering a row the processor already moved to a terminal state.
    const next = (row.attempts || 0) + 1 >= MAX_ATTEMPTS ? 'needs_review' : 'queued'
    try {
      await db.from('class_booking_requests').update({ status: next, last_error: error })
        .eq('id', row.id).eq('status', 'processing')
    } catch {
      // Bookkeeping is best-effort — a row left in 'processing' is
      // re-queued by the cron's reaper.
    }
    return { status: 'failed', error, requeued: next === 'queued' }
  }
}
