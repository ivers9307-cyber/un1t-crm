// LEAVEPHONE.1 — every decision the "Request time off" form makes, kept out of
// the .jsx because there is no React Native component test runner: the screen
// renders what these return and nothing else.
//
// 🔴 THIS MODULE NEVER COUNTS DAYS. What a request costs is decided by the
// server (chargeableLeaveSegments: Mon-Fri, minus the studio country's bank
// holidays, minus that studio's closures — HOLIDAYLEAVE.1), from lists the
// phone cannot read. The number shown before submit is the preview's
// (GET /api/schedule/time-off?preview=1 → data.days); the number confirmed
// after submit is the POST's (data_all[].total_days). There is no local
// fallback on purpose: "Counting days…" is honest, an off-by-one is not.
//
//   • available — allowance.remaining MINUS pending holiday days. The
//     allowances route returns `remaining` without that deduction, while the
//     POST refuses on `remaining - pendingDays`, so the form subtracts the same
//     sum from the coach's own requests (whose total_days are the server's).

import { isRestrictedEmployment, timeOffTypeLabel, leaveRangeLabel, leavePreviewLine } from 'shared/time-off'

const unknownPreview = () => ({ known: false, days: null, clashes: [] })
const plural = (n, one, many) => (n === 1 ? one : many)
const MAX_CLASH_LINES = 8

/**
 * The preview route answers { data: { days: { total, segments }, clashes } }.
 * A deployment that predates it ignores `preview=1` and answers with the
 * request LIST (an array), so anything but the object shape is "unknown" —
 * the form then shows no count and no clash list. Unknown must never render
 * as "0 days" or "no clashes".
 */
export function leavePreviewFrom(res) {
  const d = res?.success && res.data && !Array.isArray(res.data) ? res.data : null
  if (!d || !Array.isArray(d.clashes) || typeof d.days?.total !== 'number' || !Array.isArray(d.days.segments)) {
    return unknownPreview()
  }
  return { known: true, days: d.days, clashes: d.clashes }
}

/** The days card's one line. AUTHORITATIVE when preview.known; otherwise it says it does not know. */
export function leaveDaysLabel({ loading, preview }) {
  if (loading) return 'Counting days…'
  if (!preview?.known || !preview.days) return 'Days are counted when you submit'
  const n = preview.days.total
  if (n <= 0) return 'No working days in that range'
  return `This request uses ${n} ${plural(n, 'day', 'days')}`
}

/**
 * Mirrors the POST's pending read: type 'holiday', RAW status 'pending' (an
 * expired pending request still counts server-side), start_date in the year.
 * `profileId` (optional) keeps the sum to one person's rows: a manager's list
 * can carry colleagues' requests.
 */
export function pendingHolidayDays(requests, year, profileId = null) {
  return (requests || [])
    .filter((r) => r?.type === 'holiday' && r.status === 'pending' && String(r.start_date).slice(0, 4) === String(year))
    .filter((r) => !profileId || r.profile_id === profileId)
    .reduce((n, r) => n + (Number(r.total_days) || 0), 0)
}

/**
 * What the balance card shows, or null when there is no card: contractors and
 * casual staff have no allowance (LEAVE.3), and nothing renders until the
 * allowance has loaded. `days` is the SERVER's preview block (or null while it
 * is unknown — then there is no "after", rather than a guessed one). `year`
 * (optional) is the year the leave starts in: an allowance still on screen for
 * a different year is not this request's balance, so it is hidden.
 */
export function leaveBalanceView({ employmentType, allowance, requests, type, days, year: wantedYear = null, profileId = null }) {
  if (isRestrictedEmployment(employmentType)) return null
  if (!allowance || allowance.not_applicable) return null
  const year = Number(allowance.year)
  const remaining = Number(allowance.remaining)
  if (!Number.isFinite(year) || !Number.isFinite(remaining)) return null
  if (wantedYear !== null && Number(wantedYear) !== year) return null
  const pending = pendingHolidayDays(requests, year, profileId)
  const available = remaining - pending
  const charged = type === 'holiday' && days ? days : null
  const inYear = charged ? charged.segments.filter((s) => s.year === year).reduce((n, s) => n + s.days, 0) : null
  const requestDays = type !== 'holiday' ? 0 : inYear
  return {
    year,
    total: Number(allowance.total_days),
    used: Number(allowance.used_days),
    carriedOver: Number(allowance.carried_over),
    pending,
    available,
    requestDays,
    after: requestDays === null ? null : available - requestDays,
    short: requestDays !== null && requestDays > available,
    otherYearDays: charged ? charged.total - inYear : 0,
  }
}

/** The balance card's words, from leaveBalanceView's numbers. null = no card. */
export function leaveBalanceLines(view, type) {
  if (!view) return null
  const breakdown = [`${view.total} allowance${view.carriedOver ? ` + ${view.carriedOver} carried over` : ''}`, `${view.used} used`]
  if (view.pending) breakdown.push(`${view.pending} pending`)
  let request = null
  if (type === 'holiday' && view.requestDays > 0) {
    request = view.short
      ? `This request needs ${view.requestDays} ${plural(view.requestDays, 'day', 'days')}. You have ${view.available}.`
      : `${view.after} ${plural(view.after, 'day', 'days')} left after this request.`
  }
  const o = view.otherYearDays
  return {
    short: view.short,
    heading: `Holiday balance ${view.year}`,
    available: `${view.available} ${plural(view.available, 'day', 'days')} available`,
    breakdown: breakdown.join(' · '),
    request,
    otherYear: o > 0
      ? `${o} of these days ${plural(o, 'falls', 'fall')} in ${view.year + 1} and ${plural(o, 'counts', 'count')} against that year’s allowance.`
      : null,
  }
}

/**
 * The amber "you are rostered" card, or null. Only when the preview is KNOWN
 * and non-empty: an unknown preview must not read as "no clashes", and it must
 * not list rows either.
 */
export function leaveClashSummary(preview) {
  const list = preview?.known && Array.isArray(preview.clashes) ? preview.clashes : []
  if (list.length === 0) return null
  return {
    count: list.length,
    heading: `You are rostered on ${list.length} ${plural(list.length, 'shift', 'shifts')} in these dates`,
    lines: list.slice(0, MAX_CLASH_LINES).map((c, i) => ({ id: c?.id || `clash-${i}`, text: leavePreviewLine(c) })),
    more: list.length > MAX_CLASH_LINES ? `and ${list.length - MAX_CLASH_LINES} more` : null,
    footer: 'A manager will need to cover these.',
  }
}

/** Days the POST actually charged: every year segment it inserted. null when the response does not say. */
export function submittedDays(res) {
  const rows = Array.isArray(res?.data_all) && res.data_all.length > 0 ? res.data_all : (res?.data ? [res.data] : [])
  const nums = rows.map((r) => (r?.total_days == null ? NaN : Number(r.total_days))).filter((n) => Number.isFinite(n))
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null
}

/** The confirmation shown after a successful submit. `days` is submittedDays(res). */
export function leaveSubmittedMessage({ type, startIso, endIso, days, clashCount }) {
  const head = [timeOffTypeLabel(type), leaveRangeLabel(startIso, endIso)]
  if (days !== null && days !== undefined) head.push(`${days} ${plural(days, 'day', 'days')}`)
  const lines = [`${head.join(' · ')}.`, 'Your manager has been notified. Track it under My leave.']
  const c = Number(clashCount) || 0
  if (c > 0) lines.push(`You are still rostered on ${c} ${plural(c, 'shift', 'shifts')} in that time. A manager will need to cover these.`)
  return { title: 'Request sent', message: lines.join('\n') }
}
