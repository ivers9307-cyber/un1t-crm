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
//                        flag needs_review AND file a staff approvals
//                        card (routeToReview, reason 'processing_error', or
//                        the error's own reviewReason, e.g. CreditReadError's
//                        'credit_check_failed')
//                        — a bare needs_review is on no screen. The
//                        .eq('status','processing') guard stops this
//                        ever clobbering a row the processor already
//                        moved to a terminal state; only a row the guard
//                        matched gets a card.
//
// A consumer that CRASHES mid-run (function timeout, deploy) leaves the
// row in 'processing'; the cron's reaper — deliberately CRON-ONLY —
// re-queues it after its staleness window.

import { processClassBookingRequest, routeToReview } from './class-booking-processor.js'
import { logWarn, logError } from '@/lib/log'

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
    // CBPCREDITREAD.1 — a throw may name its own staff-card reason
    // (CreditReadError → 'credit_check_failed'), so staff see WHAT could not
    // be done instead of a generic error. Duck-typed on purpose: this lib must
    // not depend on the processor's classes (its unit test mocks the module).
    const reviewReason = (typeof e?.reviewReason === 'string' && e.reviewReason) || 'processing_error'
    // Retry under the cap, else flag for staff. The status guard stops this
    // ever clobbering a row the processor already moved to a terminal state.
    const atCap = (row.attempts || 0) + 1 >= MAX_ATTEMPTS
    const next = atCap ? 'needs_review' : 'queued'
    let flagged = null
    try {
      const { data, error: stampErr } = await db.from('class_booking_requests')
        .update({ status: next, last_error: error })
        .eq('id', row.id).eq('status', 'processing')
        .select('id, approval_request_id')
      if (stampErr) throw stampErr
      flagged = (data || [])[0] || null
    } catch (stampErr) {
      // Bookkeeping is best-effort — a row left in 'processing' is
      // re-queued by the cron's reaper (and, past the cap, carded there).
      logWarn('class-booking-queue', 'failure bookkeeping failed; the reaper picks the row up', { requestId: row.id, err: stampErr })
    }
    if (atCap && flagged) {
      // The retries are spent: a bare needs_review is on no screen, so file
      // the staff card (approval_request_id + approver push). routeToReview
      // reuses a card the row already names, and falls back to 'failed' with
      // review_unavailable:* when no card can be filed. Only a row the guard
      // above matched gets here — never one the processor stamped itself.
      try {
        const review = await routeToReview(db, { ...row, approval_request_id: flagged.approval_request_id ?? row.approval_request_id ?? null }, reviewReason)
        if (review?.outcome !== 'needs_review') {
          logError('class-booking-queue', 'retries exhausted and no staff card could be filed', { requestId: row.id, detail: review?.detail })
        }
      } catch (reviewErr) {
        logError('class-booking-queue', 'retries exhausted and filing the staff card threw', { requestId: row.id, err: reviewErr })
      }
    }
    return { status: 'failed', error, requeued: next === 'queued' }
  }
}
