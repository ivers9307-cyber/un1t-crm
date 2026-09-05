// MIA-REVIEW.3 (3.18) — recovery for an approval that crashed mid-execution.
//
// PATCH /api/agent/membership-requests/[id] claims a row atomically
// (pending → approved) BEFORE the Glofox / registration call runs, so two
// staff can't double-execute. If the process then dies (deploy, serverless
// timeout, crash) the row is stuck at 'approved' for an EXECUTING kind: not
// pending, so the claim predicate 409s any re-decision; never 'actioned' or
// 'failed'; no confirmation sent; and no cron reconciles the table. The
// customer was told the team would confirm shortly and the class is never
// booked.
//
// No migration is available for this fix, so the marker lives in the row's
// existing `details` JSONB: `details.execution = { stage, started_at, by }`.
// The claim writes stage 'executing'; the final write flips it to 'done'.
// A row still 'executing' after EXECUTION_STALE_MS is a crashed approval —
// the route lets it be re-claimed (retried) and the review page surfaces it.
//
// Pure — imported by the route (server) AND the requests page (client).

// Kinds whose approval ALWAYS executes something in the same request. Pause
// is actioned manually in Glofox by staff (its API route rejects
// impersonation), so there is no execution window to crash inside.
export const EXECUTING_KINDS = new Set([
  'class_booking',
  'class_cancellation',
  'event_booking',
  'event_cancellation',
])

// CANCEL-FORM.5 — kinds that execute ONLY when the location opted in
// (locations.glofox_auto_cancel_memberships, mig 585). The route decides per
// request; when it does execute it stamps the same details.execution marker,
// so recovery keys on the MARKER for these, never on the kind alone.
export const CONDITIONAL_EXECUTING_KINDS = new Set(['cancellation'])

// Every kind whose 'failed' row may be re-approved (fix-&-retry lane).
export const RETRYABLE_KINDS = new Set([...EXECUTING_KINDS, ...CONDITIONAL_EXECUTING_KINDS])

// Generous relative to a Vercel function timeout: long enough that a slow but
// live Glofox call is never treated as crashed, short enough that a stuck
// booking surfaces while the class is still in the future.
export const EXECUTION_STALE_MS = 5 * 60_000

/**
 * The `started_at` of a crashed execution on this row, or null. Pure.
 * @param {object|null} row  { status, kind, details }
 * @param {number} nowMs
 */
export function stuckExecutionStartedAt(row, nowMs = Date.now()) {
  if (!row || row.status !== 'approved') return null
  if (!RETRYABLE_KINDS.has(row.kind)) return null
  // A conditional kind that never executed carries no marker → never stuck.
  const exec = row.details?.execution
  if (!exec || exec.stage !== 'executing' || !exec.started_at) return null
  const t = Date.parse(exec.started_at)
  if (!Number.isFinite(t)) return null
  return nowMs - t >= EXECUTION_STALE_MS ? exec.started_at : null
}

/** Convenience boolean for the UI. Pure. */
export function isStuckExecuting(row, nowMs = Date.now()) {
  return stuckExecutionStartedAt(row, nowMs) !== null
}

// AGENT-RETRY.1 — a FAILED execution is retryable, not terminal.
//
// Before this, a failed Glofox execution dead-ended: the row landed on
// 'failed', every re-decision 409'd ('Already decided'), and the operator
// who fixed the underlying problem (granted a credit, linked the account)
// had no way to re-run the booking — live 2026-08-24: Kate Byrne's
// YOU_HAVE_NO_CREDITS_LEFT booking had to be recovered by hand. The route
// now allows a failed EXECUTING-kind row to be re-APPROVED (fresh atomic
// claim on status='failed'), re-running the side effect. The operator
// fixes in Glofox first; the button only retries — it never fixes.
// Approve-only: decline stays pending-only (the customer was never
// confirmed, but a decline notice on a days-old failure is noise).

/** Can this row's failed execution be re-approved at all? Pure — the ROUTE's gate. */
export function isRetryableFailure(row) {
  return !!row && row.status === 'failed' && RETRYABLE_KINDS.has(row.kind)
}

// How long after the decision a failed row keeps being OFFERED for retry in
// the UI when it carries no usable start time (kinds without starts_at).
export const RETRY_OFFER_WINDOW_MS = 48 * 3_600_000

/**
 * Should the UI surface a Fix-&-retry affordance for this row? Pure —
 * stricter than isRetryableFailure: retrying a class that has already
 * started helps nobody, so rows with a parseable details.starts_at are
 * only offered while the start is still in the future; rows without one
 * (event/class cancellations, older bookings) fall back to a decided-at
 * recency window so the section can't accumulate stale history forever.
 * The route deliberately stays permissive (isRetryableFailure) — an
 * operator retrying an edge case on purpose shouldn't be refused.
 */
export function retryOffered(row, nowMs = Date.now()) {
  if (!isRetryableFailure(row)) return false
  const starts = Date.parse(row.details?.starts_at || '')
  if (Number.isFinite(starts)) return starts > nowMs
  const decided = Date.parse(row.decided_at || '')
  if (!Number.isFinite(decided)) return false
  return nowMs - decided <= RETRY_OFFER_WINDOW_MS
}

/** The details patch stamped by the claim, before the side effect runs. Pure. */
export function executingMarker(details, { startedAt, by = null }) {
  return { ...(details || {}), execution: { stage: 'executing', started_at: startedAt, by } }
}

/** The details patch written once execution finished (either way). Pure. */
export function finishedMarker(details, { finishedAt }) {
  const exec = (details || {}).execution
  if (!exec) return details || {}
  return { ...details, execution: { ...exec, stage: 'done', finished_at: finishedAt } }
}
