// LEAVEDAYS.1 — every decision the web leave form's "days requested" line
// makes, kept out of TimeOffManager.jsx so the component only has to wire a
// debounced fetch to it.
//
// The form used to count CALENDAR days in the browser and judge "exceeds
// balance" on that. Since HOLIDAYLEAVE.1 the POST charges a holiday in WORKING
// days (Mon-Fri, minus the studio country's bank holidays, minus the studio's
// closures — chargeableLeaveSegments), from lists the browser cannot read, so a
// bank-holiday week previewed 5 and warned where the server charges 4 and
// accepts. The number now comes from the endpoint LEAVEPHONE.1 built for the
// phone (GET /api/schedule/time-off?preview=1), which prices with the same
// function the POST charges with. Same meaning as mobile/lib/leave-form.js;
// the web cannot import it, and `shared/` publishes to phones.
//
// The preview's `clashes` are NEVER read here: they are always the CALLER's
// own shifts (a profile_id in the query is ignored by design), and this form
// can be filing for someone else.

export const LEAVE_PREVIEW_DEBOUNCE_MS = 300

// MIRRORS src/app/api/schedule/time-off/route.js, which does not export it:
// both the POST and previewOwnLeave refuse `spanDays > 366` ("Time-off
// requests are limited to one year"), with spanDays worked out in UTC exactly
// as leaveSpanDays does below. Change one, change both.
export const MAX_LEAVE_SPAN_DAYS = 366
// A date input reports every keystroke of a typed year (0002, 0020, 0202,
// 2026), each a well-formed date. Nothing before this year is a real request.
const EARLIEST_YEAR = 2000

const ISO = /^\d{4}-\d{2}-\d{2}$/
const plural = (n, one, many) => (n === 1 ? one : many)
const HOLIDAY_RULE_HINT = 'Weekends, bank holidays and days the studio is closed are not charged.'
const HOLIDAY_UNKNOWN_HINT = 'Holiday is charged in working days. They are counted when you submit.'

/** Inclusive days in [startIso, endIso], the route's own UTC arithmetic. */
function leaveSpanDays(startIso, endIso) {
  return Math.round((Date.parse(`${endIso}T00:00:00Z`) - Date.parse(`${startIso}T00:00:00Z`)) / 86400000) + 1
}

/**
 * Is this a range the form could file at all? False for an incomplete,
 * half-typed or inverted range and for one over the route's one-year limit:
 * the POST refuses each, so the form neither asks about it nor puts a day
 * count beside it.
 */
function isFileableRange(startDate, endDate) {
  if (!ISO.test(startDate || '') || !ISO.test(endDate || '') || endDate < startDate) return false
  if (Number(startDate.slice(0, 4)) < EARLIEST_YEAR) return false
  const span = leaveSpanDays(startDate, endDate)
  return Number.isFinite(span) && span <= MAX_LEAVE_SPAN_DAYS
}

/**
 * What to ask the server, or null when there is nothing worth asking: a range
 * that cannot be filed (isFileableRange), or a type the server charges in
 * CALENDAR days. Only `holiday` is charged in working days: countLeaveDays
 * (time-off-days.js) counts every day for every other type, and
 * chargeableLeaveSegments reads the bank-holiday and closure lists for
 * `holiday` alone, so for the rest the browser's count is already the server's.
 * `locationId` is the one the form POSTs; when the form has none it is left
 * off, and the route falls back to the active studio exactly as the POST does,
 * so the two cannot price against different studios.
 * `key` names the inputs a result belongs to (see leavePreviewState).
 */
export function leavePreviewRequest({ type, startDate, endDate, locationId }) {
  if (type !== 'holiday' || !isFileableRange(startDate, endDate)) return null
  const params = new URLSearchParams({ preview: '1', type, start_date: startDate, end_date: endDate })
  if (locationId) params.set('location_id', locationId)
  return { key: [type, startDate, endDate, locationId || ''].join('|'), url: `/api/schedule/time-off?${params}` }
}

/**
 * The preview answers { data: { days: { total, segments } } } — an OBJECT. A
 * deployment that predates it ignores `preview=1` and answers with the request
 * LIST (an array), so anything but the object shape is unknown. Unknown must
 * never render as "0 days".
 */
export function leavePreviewFrom(res) {
  const d = res?.success && res.data && !Array.isArray(res.data) ? res.data : null
  if (!d || !Number.isInteger(d.days?.total) || d.days.total < 0 || !Array.isArray(d.days.segments)) return { known: false, days: null }
  return { known: true, days: d.days }
}

/**
 * A stored result only counts for the inputs it was asked for. Judged here,
 * on every render, rather than by clearing state in an effect: the render
 * right after a date change must already not show the old range's number.
 */
export function leavePreviewState(request, result) {
  if (!request) return { status: 'idle', days: null }
  if (!result || result.key !== request.key) return { status: 'loading', days: null }
  return result.known ? { status: 'ok', days: result.days } : { status: 'unknown', days: null }
}

/**
 * The line under the date inputs, or null for no line.
 *   { text, transient, balance, exceeds, hint, note }
 * `transient` marks "Counting days...": the form hides it from the live region
 * so a screen reader hears each settled line once, not the wait before it.
 *
 * `exceeds` is judged on the SERVER's number only, and only where the form
 * always judged it: a holiday, for yourself, with an allowance that applies.
 * (On behalf, the allowance in hand is the manager's own.)
 *
 * The POST refuses on `days > remaining - pending holiday days`, so that is
 * the figure judged: `allowance.pending_days` is that same sum, from the same
 * function (getPendingHolidayDays). An allowance WITHOUT it (a deployment that
 * predates the field, or a sum the server could not read) is judged on
 * `remaining` alone, as the form always did, and says so: "before pending
 * requests". That judgement is never wrong, but its absence is not a promise.
 *
 * The allowance is ONE year's. The server splits a range at 31 December and
 * charges each year its own days, so only the segments in the allowance's
 * year are judged against it; the rest are named in `note` and left to the
 * POST, which reads that year's allowance.
 */
export function leaveDaysView({ calendarDays, preview, type, onBehalf, allowance, startDate, endDate }) {
  if (!(calendarDays > 0) || !isFileableRange(startDate, endDate)) return null
  const view = { text: '', transient: false, balance: null, exceeds: false, hint: null, note: null }
  const requested = (n) => `${n} ${plural(n, 'day', 'days')} requested`
  // Charged in calendar days (see leavePreviewRequest): nothing to wait for.
  if (type !== 'holiday') return { ...view, text: requested(calendarDays) }

  const status = preview?.status
  if (!status || status === 'idle') return null
  if (status === 'loading') return { ...view, text: 'Counting days...', transient: true }

  const judged = !!allowance && !onBehalf && !allowance.not_applicable
  const year = allowance?.year == null ? NaN : Number(allowance.year)
  const yearKnown = Number.isFinite(year)
  const pending = allowance?.pending_days == null ? NaN : Number(allowance.pending_days)
  const pendingKnown = Number.isFinite(pending) && pending >= 0
  const balanceText = (inYearOnly) => {
    const head = `${allowance.remaining} remaining${inYearOnly ? ` in ${year}` : ''}`
    if (!pendingKnown) return `${head} before pending requests`
    return pending > 0 ? `${head}, ${pending} pending` : head
  }

  if (status !== 'ok' || !preview.days) {
    // No server number: the calendar count, named as what it is, and no
    // judgement the POST might contradict.
    view.text = `${calendarDays} calendar ${plural(calendarDays, 'day', 'days')}`
    view.hint = HOLIDAY_UNKNOWN_HINT
    const touchesYear = !yearKnown
      || (Number(startDate.slice(0, 4)) <= year && year <= Number(endDate.slice(0, 4)))
    if (judged && touchesYear) view.balance = balanceText(false)
    return view
  }

  const { total, segments } = preview.days
  if (total < calendarDays) view.hint = HOLIDAY_RULE_HINT
  // The POST refuses this range with the same words.
  if (total <= 0) return { ...view, text: 'No working days in that range' }
  view.text = requested(total)
  if (!judged) return view

  const inYear = yearKnown
    ? segments.filter((s) => Number(s?.year) === year).reduce((n, s) => n + (Number(s.days) || 0), 0)
    : total
  const other = total - inYear
  const otherYears = [...new Set(segments.filter((s) => Number(s?.year) !== year && Number(s?.days) > 0).map((s) => s.year))]
  const named = other > 0 && otherYears.length > 0
  if (inYear > 0) {
    view.balance = balanceText(named)
    view.exceeds = inYear > allowance.remaining - (pendingKnown ? pending : 0)
  }
  if (named) {
    view.note = `${other} of these days ${plural(other, 'falls', 'fall')} in ${otherYears.join(' and ')} and ${plural(other, 'counts', 'count')} against that year's allowance. That balance is checked when you submit.`
  }
  return view
}
