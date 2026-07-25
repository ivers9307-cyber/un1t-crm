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

// Kinds whose approval EXECUTES something in the same request. Pause and
// cancellation are actioned manually in Glofox by staff, so there is no
// execution window to crash inside.
export const EXECUTING_KINDS = new Set([
  'class_booking',
  'class_cancellation',
  'event_booking',
  'event_cancellation',
])

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
  if (!EXECUTING_KINDS.has(row.kind)) return null
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
