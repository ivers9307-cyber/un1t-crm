// C85 (c) — what the phone says when an approved agent request's action
// failed. The Approvals screen alerted the raw code (e.g.
// `TRIAL_GRANT_FAILED`) and the thread's approval card printed `(CODE)`.
// Both now read the operator sentence the web shows: failureExplanation,
// one definition in shared/agent-request-failure.js. Staff-facing copy.
// Pure, tested in approval-outcome.test.js (there is no RN component runner).

import { failureExplanation } from 'shared/agent-request-failure'

// MIA-EXPIRY-QUIET.1 — the past-start guard refused the booking: the card
// expired, nothing was booked, and the member was deliberately not messaged.
// The web decide card says the same.
export const CLASS_STARTED_MESSAGE =
  'That class had already started, so nothing was booked. The member has NOT been messaged; please follow up with them.'

/**
 * The alert after an approve whose action failed, or null when there is
 * nothing to say. `res` is the PATCH /api/agent/membership-requests/[id]
 * answer: { success, request, executed }.
 *
 * @returns {{ title: string, message: string } | null}
 */
export function approveFailureAlert(res) {
  const executed = res?.executed
  if (!executed || executed.ok !== false) return null
  if (res?.request?.status === 'expired' || executed.reason === 'CLASS_ALREADY_STARTED') {
    return { title: 'Not booked', message: CLASS_STARTED_MESSAGE }
  }
  const explain = failureExplanation({ status: 'failed', details: { result: executed } })
  return { title: 'Approved, but the action failed', message: `${explain} The customer has NOT been confirmed.` }
}

/**
 * The line under a FAILED approval card in a thread, or null. Only a card
 * whose execution recorded a result has one (a failed row with no result
 * says nothing extra, as before).
 *
 * @returns {string | null}
 */
export function failedCardExplanation(request) {
  if (!request || request.status !== 'failed' || !request.details?.result) return null
  return failureExplanation(request)
}
