// LEAVEPHONE.1 — the "My leave" list: the coach's own requests grouped by
// status, with the manager's review note. Pure; the screen only renders it.
//
// `effective_status` is the server's (GET /api/schedule/time-off annotates
// every row, LEAVE.2): a pending request whose last day has passed is
// 'expired'. Cancel is NOT re-decided here — canCancelTimeOff is the existing
// rule and the same one the Schedule tab's amber card uses: the caller's own
// request, RAW status pending. Approved leave cannot be self-cancelled.

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
