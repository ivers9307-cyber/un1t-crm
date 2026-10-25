// LEAVECANCEL.1 — the words the WEB says about a request to cancel approved
// leave, in one place so the Time Off page and the dashboard's My requests
// card cannot drift. Pure strings, no imports: safe in a client bundle.
// (The phone's words are mobile/lib/my-leave.js.)

// Keyed by the `cancellation` field the routes answer with.
export const LEAVE_CANCEL_NOTICES = Object.freeze({
  requested: 'Sent to an owner. Your leave is still approved until they decide.',
  approved: 'Cancellation approved. The leave is cancelled and the person has been told.',
  rejected: 'Cancellation declined. The leave stays approved and the person has been told.',
  withdrawn: 'Cancellation request withdrawn. Your leave is still approved.',
})

/**
 * The line under a CANCELLED row whose cancellation an owner approved, so the
 * list says how it came to be cancelled. null for every other row.
 * `row.cancel_decider` is the embed GET /api/schedule/time-off adds.
 */
export function cancelledAtRequestText(row, { own = false } = {}) {
  if (row?.status !== 'cancelled' || row.cancel_decision !== 'approved') return null
  const asker = own ? 'your' : `${row.profiles?.full_name || 'their'}${row.profiles?.full_name ? "'s" : ''}`
  return `Cancelled at ${asker} request, approved by ${row.cancel_decider?.full_name || 'an owner'}.`
}
