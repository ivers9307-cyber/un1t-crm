// LEAVEPHONE.1 — the "My leave" list: the coach's own requests grouped by
// status, with the manager's review note. Pure; the screen only renders it.
//
// `effective_status` is the server's (GET /api/schedule/time-off annotates
// every row, LEAVE.2): a pending request whose last day has passed is
// 'expired'. Cancel is NOT re-decided here — canCancelTimeOff is the existing
// rule and the same one the Schedule tab's amber card uses: the phone OFFERS
// Cancel on the caller's own request while its RAW status is pending, and on
// nothing else.
//
// What the server does (PUT /api/schedule/time-off/[id]): a requester who
// manages NO studio the request belongs to may only set their own PENDING
// request to cancelled; anything else is a 403 "You can only cancel your own
// pending requests". A requester who IS a manager there is not refused, and
// since LEAVECANCEL.1 their cancel of leave that was approved a moment ago
// does NOT cancel it: the server records a request for an OWNER to cancel it
// and answers { success: true, cancellation: 'requested' }, with the leave
// still approved. So the phone re-reads the list just before sending
// (stillCancellable), never reads a success as "cancelled" without looking at
// `cancellation` (myLeaveCancelOutcome), shows the server's own words on a
// refusal, and redraws from a fresh read on every outcome.
//
// LEAVECANCEL.1 — the phone still does not OFFER cancelling approved leave
// (that is the web Time Off page). It shows where such a request stands and
// lets the person withdraw it. `cancel_request_state` and `can_withdraw_cancel`
// are the server's per-row flags; absent on an older deployment, where every
// row reads exactly as before.

import { timeOffLeaveLabel, leaveDateRangeLabel } from 'shared/time-off'
import { canCancelTimeOff } from './schedule-manage'

const STATUS = {
  pending: { title: 'Pending', label: 'Pending', tone: 'amber' },
  approved: { title: 'Approved', label: 'Approved', tone: 'green' },
  rejected: { title: 'Declined', label: 'Declined', tone: 'red' },
  cancelled: { title: 'Cancelled', label: 'Cancelled', tone: 'slate' },
  expired: { title: 'Expired', label: 'Expired', tone: 'slate' },
}
const ORDER = ['pending', 'approved', 'rejected', 'cancelled', 'expired']
// Soonest first where the leave is still ahead of you; most recent first for
// the history groups.
const ASCENDING = new Set(['pending', 'approved'])

export const MY_LEAVE_EMPTY = 'You have not requested any time off yet.'
export const MY_LEAVE_CANCEL_CONFIRM = {
  title: 'Cancel this request?',
  message: 'Your request will be withdrawn. You can raise a new one at any time.',
  keep: 'Keep it',
  confirm: 'Cancel request',
}

export const MY_LEAVE_CANCEL_REQUESTED = 'Cancellation requested. Waiting for an owner; your leave is still approved.'
export const MY_LEAVE_CANCEL_SENT_TO_OWNER = {
  title: 'Sent to an owner',
  message: 'This leave was approved before your cancel arrived, so cancelling it needs an owner. They have been asked, and your leave is still approved until they decide.',
}
export const MY_LEAVE_WITHDRAW_CONFIRM = {
  title: 'Withdraw this request?',
  message: 'Your cancellation request will be withdrawn. Your leave stays approved.',
  keep: 'Leave it',
  confirm: 'Withdraw',
}

export const MY_LEAVE_NO_LONGER_PENDING = {
  title: 'Already decided',
  message: 'This request is no longer pending, so it was not cancelled. The list has been refreshed.',
}

/**
 * Just before the cancel is sent: is this row STILL the caller's own pending
 * request in a list read a moment ago? A manager may have decided it while the
 * screen sat open; then nothing is sent and the row is redrawn as it now is.
 */
export function stillCancellable(freshRows, id, profile) {
  const row = (freshRows || []).find((r) => r && r.id === id)
  return !!row && canCancelTimeOff(row, profile)
}

/**
 * What to tell the coach after the cancel PUT. null = it was cancelled; the
 * redrawn list says so. `cancellation: 'requested'` is a success that
 * cancelled NOTHING (an owner was asked), so it is said out loud.
 */
export function myLeaveCancelOutcome(res) {
  if (res?.success) return res.cancellation === 'requested' ? MY_LEAVE_CANCEL_SENT_TO_OWNER : null
  return { title: 'Couldn’t cancel', message: res?.error || 'Unknown error' }
}

/** After the withdraw DELETE. null = it worked; the redrawn list says so. */
export function myLeaveWithdrawOutcome(res) {
  if (res?.success) return null
  return { title: 'Couldn’t withdraw', message: res?.error || 'Unknown error' }
}

// LEAVECANCEL.1 — the line under approved leave whose cancellation was asked for.
function cancelNoteOf(r) {
  if (r?.cancel_request_state === 'open') return MY_LEAVE_CANCEL_REQUESTED
  if (r?.cancel_request_state === 'rejected' && r.status === 'approved') {
    return `Cancellation declined. Your leave stays approved.${r.cancel_decision_note ? ` "${r.cancel_decision_note}"` : ''}`
  }
  return null
}

// ONE reading of a row's status, used by the row and by the grouping, so a
// row can never be labelled one thing and filed under another (or under
// nothing). The status CHECK (mig 011) makes the last fallback unreachable.
function statusOf(r) {
  if (STATUS[r?.effective_status]) return r.effective_status
  if (STATUS[r?.status]) return r.status
  return 'pending'
}

export function myLeaveRow(r, profile) {
  const status = statusOf(r)
  const days = Number(r.total_days) || 0
  const range = leaveDateRangeLabel(r.start_date, r.end_date)
  const note = r.review_note || null
  return {
    id: r.id,
    title: timeOffLeaveLabel(r.type),
    range,
    summary: `${range} · ${days} ${days === 1 ? 'day' : 'days'}`,
    days,
    status,
    statusLabel: STATUS[status].label,
    tone: STATUS[status].tone,
    reason: r.reason || null,
    note,
    noteHeading: note ? (r.reviewer?.full_name ? `Note from ${r.reviewer.full_name}` : 'Manager’s note') : null,
    canCancel: status === 'pending' && canCancelTimeOff(r, profile),
    cancelNote: cancelNoteOf(r),
    canWithdrawCancel: r.can_withdraw_cancel === true && !!profile?.id && r.profile_id === profile.id,
  }
}

export function myLeaveSections(requests, profile) {
  if (!profile?.id) return []
  const mine = (requests || []).filter((r) => r && r.profile_id === profile.id)
  return ORDER.map((key) => {
    const dir = ASCENDING.has(key) ? 1 : -1
    const rows = mine
      .filter((r) => statusOf(r) === key)
      .sort((a, b) => dir * String(a.start_date).localeCompare(String(b.start_date)))
      .map((r) => myLeaveRow(r, profile))
    return { key, title: STATUS[key].title, rows }
  }).filter((s) => s.rows.length > 0)
}
