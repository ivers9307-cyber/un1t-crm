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

const ISO = /^\d{4}-\d{2}-\d{2}$/
const plural = (n, one, many) => (n === 1 ? one : many)
const HOLIDAY_RULE_HINT = 'Weekends, bank holidays and days the studio is closed are not charged.'
const HOLIDAY_UNKNOWN_HINT = 'Holiday is charged in working days. They are counted when you submit.'

/**
 * What to ask the server, or null when there is nothing worth asking: an
 * incomplete, half-typed or inverted range (the route would 400 each one).
 * `locationId` is the one the form POSTs; when the form has none it is left
 * off, and the route falls back to the active studio exactly as the POST does,
 * so the two cannot price against different studios.
 * `key` names the inputs a result belongs to (see leavePreviewState).
 */
export function leavePreviewRequest({ type, startDate, endDate, locationId }) {
  if (!type || !ISO.test(startDate || '') || !ISO.test(endDate || '') || endDate < startDate) return null
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
  if (!d || typeof d.days?.total !== 'number' || !Array.isArray(d.days.segments)) return { known: false, days: null }
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
 *   { text, balance, exceeds, hint, note }
 * `exceeds` is judged on the SERVER's number only, and only where the form
 * always judged it: a holiday, for yourself, with an allowance that applies.
 * (On behalf, the allowance in hand is the manager's own.)
 *
 * The allowance is ONE year's. The server splits a range at 31 December and
 * charges each year its own days, so only the segments in the allowance's
 * year are judged against it; the rest are named in `note` and left to the
 * POST, which reads that year's allowance. `remaining` does not deduct
 * PENDING holiday requests and the POST does, so "exceeds" is never wrong but
 * its absence is not a promise.
 */
export function leaveDaysView({ calendarDays, preview, type, onBehalf, allowance, startDate, endDate }) {
  const status = preview?.status
  if (!(calendarDays > 0) || !status || status === 'idle') return null
  const view = { text: '', balance: null, exceeds: false, hint: null, note: null }
  if (status === 'loading') return { ...view, text: 'Counting days...' }

  const judged = type === 'holiday' && !!allowance && !onBehalf && !allowance.not_applicable
  const year = allowance?.year == null ? NaN : Number(allowance.year)
  const yearKnown = Number.isFinite(year)

  if (status !== 'ok' || !preview.days) {
    // No server number: the calendar count, named as what it is, and no
    // judgement the POST might contradict.
    view.text = `${calendarDays} calendar ${plural(calendarDays, 'day', 'days')}`
    if (type === 'holiday') view.hint = HOLIDAY_UNKNOWN_HINT
    const touchesYear = !yearKnown
      || (Number(String(startDate).slice(0, 4)) <= year && year <= Number(String(endDate).slice(0, 4)))
    if (judged && touchesYear) view.balance = `${allowance.remaining} remaining`
    return view
  }

  const { total, segments } = preview.days
  if (type === 'holiday' && total < calendarDays) view.hint = HOLIDAY_RULE_HINT
  if (total <= 0) {
    // The POST refuses this range with the same words.
    return { ...view, text: 'No working days in that range' }
  }
  view.text = `${total} ${plural(total, 'day', 'days')} requested`
  if (!judged) return view

  const inYear = yearKnown
    ? segments.filter((s) => Number(s?.year) === year).reduce((n, s) => n + (Number(s.days) || 0), 0)
    : total
  const other = total - inYear
  if (inYear > 0) {
    view.balance = `${allowance.remaining} remaining${other > 0 ? ` in ${year}` : ''}`
    view.exceeds = inYear > allowance.remaining
  }
  if (other > 0) {
    const years = [...new Set(segments.filter((s) => Number(s?.year) !== year && Number(s?.days) > 0).map((s) => s.year))]
    view.note = `${other} of these days ${plural(other, 'falls', 'fall')} in ${years.join(' and ')} and ${plural(other, 'counts', 'count')} against that year's allowance. That balance is checked when you submit.`
  }
  return view
}
