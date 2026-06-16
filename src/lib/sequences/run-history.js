// Pure mapping of a sequence_enrollments row → a display summary for the
// automation Performance view's "Recent activity" list. No IO.

const REASON_LABELS = { goal_met: 'goal met' }

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
