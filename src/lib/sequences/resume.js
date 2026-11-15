// SEQ-RESUME.1 — pure helpers for resuming a paused enrollment.
//
// Enrollments auto-pause after MAX_ERRORS consecutive step failures
// (scheduler.js) with next_step_at=null. The 2026-07-10 comms-audit
// remediation had to resume 11 of them via raw SQL — this is the shape that
// resume used, verified against the scheduler in production that day.

/**
 * The exact patch the scheduler expects to pick a paused enrollment back up:
 * active again, due immediately (next tick, ≤5 min), with the error ledger
 * cleared so MAX_ERRORS counts fresh failures rather than pausing again on
 * the first hiccup.
 *
 * @param {Date} [now]
 * @param {string|null} [dueAt] the row's current next_step_at, kept when later than now
 */
export function buildResumePatch(now = new Date(), dueAt = null) {
  // SEQPAUSE.1 — a row paused mid-step already holds its NEXT step's time
  // (the runner moved it past the step it was sending); resuming before then
  // must not skip that wait. An earlier, missing or unreadable time is "now".
  const due = dueAt ? Date.parse(dueAt) : NaN
  const at = Number.isFinite(due) && due > now.getTime() ? new Date(due) : now
  return {
    status: 'active',
    next_step_at: at.toISOString(),
    error_count: 0,
    last_error: null,
  }
}

/**
 * Map a CAS-on-status='paused' update result to an HTTP outcome.
 * The update is compare-and-set (…eq('status','paused')), so a double-click
 * or a race loses cleanly: zero rows updated → look at the row's current
 * status to distinguish "gone" (404) from "not paused any more" (409).
 *
 * @param {{ updatedRow: object|null, currentStatus: string|null }} args
 * @returns {{ ok: boolean, status: number, error?: string }}
 */
export function classifyResumeOutcome({ updatedRow, currentStatus }) {
  if (updatedRow) return { ok: true, status: 200 }
  if (!currentStatus) return { ok: false, status: 404, error: 'Enrollment not found' }
  return { ok: false, status: 409, error: `Enrollment is ${currentStatus}, not paused — nothing to resume` }
}
