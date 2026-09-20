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
// What the server does today (PUT /api/schedule/time-off/[id]): a requester
// who manages NO studio the request belongs to may only set their own PENDING
// request to cancelled; anything else is a 403 "You can only cancel your own
// pending requests". That 403 is skipped for a requester who IS a manager
// there, so the server alone does not stop a manager's cancel landing on a
// request that was approved a moment ago. The phone therefore never relies on
// the server to refuse: it re-reads the list just before sending
// (stillCancellable), shows the server's own words on a refusal
// (myLeaveCancelOutcome), and redraws from a fresh read on every outcome.

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

/** What to tell the coach after the cancel PUT. null = it worked; the redrawn list says so. */
export function myLeaveCancelOutcome(res) {
  if (res?.success) return null
  return { title: 'Couldn’t cancel', message: res?.error || 'Unknown error' }
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
