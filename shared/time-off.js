// Canonical time-off type catalogue + employment-gated option lists. Shared by
// web (RequestTimeOffModal, TimeOffManager) + mobile (time-off-new) so the
// gating can't drift. The DB CHECK (mig 283) allows all five; the manager
// approval screen + reports render/bucket them.
//
// Gating (product decision 2026-06-17): full-time employees get the four leave
// types; contractors + casual staff got 'unavailable' only. Unknown/null
// employment defaults to the full menu (don't over-restrict a mis-typed FTE).
//
// AVAIL.3 (mig 631): 'unavailable' is no longer REQUESTED by anyone. Saying
// when you can't work is My availability (AVAIL.1/2): self-declared, no
// approval, managers told. So contractors and casual staff have nothing to
// request here at all, and every form sends them there instead. The type stays
// in TIME_OFF_TYPES, the labels and the DB CHECK because past rows keep it.

export const TIME_OFF_TYPES = [
  { value: 'holiday', label: 'Holiday' },
  { value: 'sick', label: 'Sick' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'other', label: 'Other' },
  { value: 'unavailable', label: 'Unavailable' },
]

// employment_type values that only get 'unavailable'.
const RESTRICTED_EMPLOYMENT = ['contractor', 'casual']
const FTE_VALUES = ['holiday', 'sick', 'unpaid', 'other']
const RESTRICTED_VALUES = ['unavailable']

// AVAIL.3 — types nobody may file as a NEW request (history keeps them).
export const NON_REQUESTABLE_TYPES = Object.freeze(['unavailable'])

export function isRequestableTimeOffType(type) {
  return !NON_REQUESTABLE_TYPES.includes(type)
}

export function allowedTimeOffValues(employmentType) {
  return RESTRICTED_EMPLOYMENT.includes(employmentType) ? RESTRICTED_VALUES : FTE_VALUES
}

export function timeOffTypesFor(employmentType) {
  const allowed = allowedTimeOffValues(employmentType)
  return TIME_OFF_TYPES.filter(t => allowed.includes(t.value) && isRequestableTimeOffType(t.value))
}

// null when there is nothing to request (AVAIL.3: contractors, casual staff).
export function defaultTimeOffTypeFor(employmentType) {
  return timeOffTypesFor(employmentType)[0]?.value ?? null
}

// AVAIL.3 — false = send this person to My availability instead of a form.
export function canRequestTimeOff(employmentType) {
  return timeOffTypesFor(employmentType).length > 0
}

export function timeOffTypeLabel(value) {
  return TIME_OFF_TYPES.find(t => t.value === value)?.label || value
}

// LEAVE.2 — employment gate as a yes/no, for the SERVER'S DECISIONS on
// existing rows (approve). A restricted employment may only ever hold
// 'unavailable'; since AVAIL.3 nobody files a NEW one (the POST refuses it
// with UNAVAILABLE_MOVED_ERROR before this gate), but a pending one filed
// before the move can still be decided.
export function isRestrictedEmployment(employmentType) {
  return RESTRICTED_EMPLOYMENT.includes(employmentType)
}

export function isTimeOffTypeAllowedFor(employmentType, type) {
  return isRestrictedEmployment(employmentType) ? RESTRICTED_VALUES.includes(type) : true
}

export const RESTRICTED_TYPE_ERROR =
  'Contractors don’t book leave. Set the days and times you can’t work in My availability, on the Schedule screen.'

// AVAIL.3 — recording leave for a contractor (an approver on their behalf).
export const RESTRICTED_TYPE_ON_BEHALF_ERROR =
  'Contractors don’t take leave, so there is nothing to record for them. They set the days and times they can’t work in My availability, on the Schedule screen.'

// AVAIL.3 — the POST's answer to a new 'unavailable' request (an old phone
// or a stale tab still offers it). The old phone shows it in its
// "Couldn't submit" alert, so it must say where to go.
export const UNAVAILABLE_MOVED_ERROR =
  'Unavailable is no longer a time-off request. Set the days and times you can’t work in My availability, on the Schedule screen. No approval is needed, and your managers are told.'

// AVAIL.3 — the same refusal when an approver records it for someone else:
// they are not the person who can't work, so it speaks about that person.
export const UNAVAILABLE_MOVED_ON_BEHALF_ERROR =
  'Unavailable is no longer a time-off request. Each person sets the days and times they can’t work themselves, in My availability on the Schedule screen. No approval is needed, and managers are told.'

// AVAIL.3 — approving a contractor's holiday/sick/unpaid/other (existing rows).
export const CONTRACTOR_DECIDE_ERROR =
  'Contractors don’t take leave. Decline this request: they can set when they can’t work in My availability.'

// AVAIL.3 — what a form shows instead of itself when there is nothing to request.
export const AVAILABILITY_INSTEAD = Object.freeze({
  title: 'Use My availability instead',
  message: 'Contractors don’t request time off. Say when you can’t work in My availability: no approval is needed, and your managers are told.',
  action: 'Open My availability',
  onBehalf: 'Contractors don’t take leave, so there is nothing to record here. They set when they can’t work in their own availability.',
})

// LEAVE.2 — the calendar/card label for a leave type. The calendars used to
// know holiday, sick and unavailable only, so approved unpaid and "other"
// leave rendered as "Unavailable" (web) or "Time off" (mobile).
const LEAVE_LABELS = {
  holiday: 'Holiday',
  sick: 'Sick leave',
  unpaid: 'Unpaid leave',
  other: 'Other leave',
  unavailable: 'Unavailable',
}

export function timeOffLeaveLabel(type) {
  return LEAVE_LABELS[type] || 'Time off'
}

// LEAVE.2 — a pending request whose last day has passed can no longer be
// decided in any useful way. It is EXPIRED, derived at read time rather than
// stored: the status CHECK (mig 011) has no `expired`, and a stored status
// would need a migration plus a cron to keep it true, while the derivation is
// always right the moment the day turns. Dates are YYYY-MM-DD, so string
// comparison is date comparison; `todayIso` must be the Dublin business day.
export function isExpiredPendingRequest(request, todayIso) {
  return !!request && request.status === 'pending' && !!request.end_date && !!todayIso && request.end_date < todayIso
}

export function effectiveTimeOffStatus(request, todayIso) {
  return isExpiredPendingRequest(request, todayIso) ? 'expired' : request?.status
}

// LEAVE.2 — "Clashes with N rostered shifts", or null when there are none.
export function leaveClashLabel(count) {
  const n = Number(count) || 0
  if (n <= 0) return null
  return `Clashes with ${n} rostered ${n === 1 ? 'shift' : 'shifts'}`
}

// LEAVE.1 — what to ask after an approval that left the person rostered.
// null when there is nothing to ask. `assignmentIds` goes back to
// POST /api/schedule/time-off/[id]/unassign-clashes so only the shifts the
// approver was shown are removed. Shared by the web page and the phone.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function shortDay(iso) {
  const [y, m, d] = String(iso).split('-').map(Number)
  if (!y || !m || !d) return String(iso)
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`
}

export function leaveClashPrompt(clashes) {
  const list = Array.isArray(clashes) ? clashes.filter((c) => c && c.id) : []
  if (list.length === 0) return null
  const lines = list.slice(0, 6).map((c) => {
    const time = c.start_time ? ` ${String(c.start_time).slice(0, 5)}` : ''
    const what = c.template_name ? ` ${c.template_name}` : ''
    const where = c.location_name ? ` (${c.location_name})` : ''
    return `${shortDay(c.block_date)}${time}${what}${where}`
  })
  if (list.length > 6) lines.push(`and ${list.length - 6} more`)
  return {
    title: leaveClashLabel(list.length),
    message: `Approved, but they are still on the roster:\n${lines.join('\n')}`,
    assignmentIds: list.map((c) => c.id),
  }
}

// LEAVEPHONE.1 — "Mon 5 Oct – Fri 9 Oct". The year is printed only when the
// range crosses a year end, where "30 Dec – 2 Jan" alone is ambiguous. Built on
// shortDay above, which reads the ISO string's own parts (Date.UTC), so the
// phone's timezone can never shift the day.
// Named leaveDateRangeLabel, not leaveRangeLabel: src/lib/roster-publish-advisories.js
// already exports a leaveRangeLabel with different wording ("on leave 21 to 27
// Sep", for the publish preview), and tests/shared-pair-sync.test.js rightly
// refuses two modules exporting one name for two meanings.
export function leaveDateRangeLabel(startIso, endIso) {
  if (!startIso) return ''
  const end = endIso || startIso
  if (end === startIso) return shortDay(startIso)
  const crossesYear = String(startIso).slice(0, 4) !== String(end).slice(0, 4)
  const withYear = (iso) => `${shortDay(iso)} ${String(iso).slice(0, 4)}`
  return crossesYear ? `${withYear(startIso)} – ${withYear(end)}` : `${shortDay(startIso)} – ${shortDay(end)}`
}

// LEAVEPHONE.1 — one line per shift the leave form's clash preview lists. The
// times are the EFFECTIVE ones the server resolved (override → block →
// template), so this only trims them to HH:MM.
export function leavePreviewLine(shift) {
  const hhmm = (t) => (t ? String(t).slice(0, 5) : '')
  const start = hhmm(shift?.start_time)
  const end = hhmm(shift?.end_time)
  const time = start && end ? `${start}–${end}` : start
  const day = shift?.block_date ? shortDay(shift.block_date) : ''
  return [day, time, shift?.template_name, shift?.location_name]
    .filter(Boolean)
    .join(' · ')
}
