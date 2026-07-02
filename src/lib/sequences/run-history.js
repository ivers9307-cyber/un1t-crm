// Pure mapping of a sequence_enrollments row → a display summary for the
// automation Performance view's "Recent activity" list. No IO.

const REASON_LABELS = { goal_met: 'goal met' }

/**
 * Where an ACTIVE enrolment's next step sits relative to now — pure, for the
 * Performance roster's "what's happening" column. The runner ticks every 5
 * minutes, so an overdue next_step_at means "runs on the next tick", not a
 * fault.
 *
 * @param {string|null} nextStepAt ISO timestamp (sequence_enrollments.next_step_at)
 * @param {number} nowMs           Date.now() from the caller (injectable for tests)
 * @returns {{ overdue: boolean, minutes: number }|null} null when absent/unparseable
 */
export function describeNextStep(nextStepAt, nowMs) {
  if (!nextStepAt) return null
  const due = new Date(nextStepAt).getTime()
  if (!Number.isFinite(due)) return null
  const deltaMs = due - nowMs
  if (deltaMs <= 0) return { overdue: true, minutes: 0 }
  return { overdue: false, minutes: Math.ceil(deltaMs / 60000) }
}

/**
 * @param {object} e         enrollment row ({ status, current_step_order, exit_reason, last_error })
 * @param {number} stepCount total steps in the automation (0 → omit "of N")
 * @returns {{ state: string, stepLabel: string, outcome: string }}
 */
export function summariseEnrolmentRun(e, stepCount) {
  const status = e?.status || 'unknown'
  const stepNum = (Number(e?.current_step_order) || 0) + 1
  const stepLabel = stepCount > 0 ? `Step ${stepNum} of ${stepCount}` : `Step ${stepNum}`

  let outcome
  switch (status) {
    case 'active': outcome = 'In progress'; break
    case 'completed': outcome = 'Completed'; break
    case 'exited': {
      const r = e?.exit_reason
      outcome = r ? `Exited: ${REASON_LABELS[r] || r}` : 'Exited'
      break
    }
    case 'paused': outcome = e?.last_error ? `Paused: ${e.last_error}` : 'Paused'; break
    default: outcome = status
  }
  return { state: status, stepLabel, outcome }
}
