// SEQGAPS.1 — pure helpers for the operator's MANUAL exit of one enrolment.
//
// Deliberate mirror of resume.js. SEQEXIT.1 gave the engine two automatic
// exits (goal_met, left_audience); this is the override for when neither
// fires and a human decides this contact should stop hearing from the
// sequence. There is no re-entry path — an exit is irreversible, which is
// why the UI confirms first and why the route CAS-es rather than blind-writes.

/** The two statuses a manual exit may act on. A completed or already-exited
 * enrolment is finished; re-writing it would restate history, not change it. */
export const EXITABLE_STATUSES = ['active', 'paused']

/** exit_reason is free text; this is the value AutomationPerformance labels. */
export const MANUAL_EXIT_REASON = 'manual_exit'

/**
 * The patch that takes an enrolment out of the flow for good.
 * next_step_at=null is the load-bearing half: the scheduler picks work up by
 * that column, so nulling it is what actually unschedules the enrolment.
 *
 * @param {Date} [now]
 */
export function buildExitPatch(now = new Date()) {
  return {
    status: 'exited',
    exit_reason: MANUAL_EXIT_REASON,
    next_step_at: null,
    last_processed_at: now.toISOString(),
  }
}

/**
 * Map a CAS-on-status-IN-(active,paused) update result to an HTTP outcome.
 * Zero rows updated is BENIGN — a double-click, or the scheduler completing
 * the enrolment a moment earlier — so it is a 409 with a plain explanation,
 * never a 500. A missing row is a 404 (detail routes don't confirm ids).
 *
 * @param {{ updatedRow: object|null, currentStatus: string|null }} args
 * @returns {{ ok: boolean, status: number, error?: string }}
 */
export function classifyExitOutcome({ updatedRow, currentStatus }) {
  if (updatedRow) return { ok: true, status: 200 }
  if (!currentStatus) return { ok: false, status: 404, error: 'Enrollment not found' }
  return {
    ok: false,
    status: 409,
    error: `This contact has already left this sequence (${currentStatus})`,
  }
}
