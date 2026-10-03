// DATECHECK.1 (review) — the one rule for a schedule report's period, shared by
// POST /api/schedule/reports (which answers it as a 400) and generateReport
// (the floor for the cron and any other caller), plus the bounded day walk the
// coverage report uses.
//
// Why a span cap: realIsoDate accepts 9999-12-31, and a string day walk steps
// from it to addDaysISO's '+010000-01', which still sorts below '9999-12-31',
// so the coverage report spun until the function timed out. 366 days matches
// the time-off routes' one-year cap (a leap year fits); the cron's longest
// period is a month.
//
// RANGEVALID.1 — the rule for EVERY schedule range, not just reports: a caller
// with a tighter cap or its own noun passes maxDays / what, and a list route
// whose bounds are each optional goes through rangeQueryError. Reversed used
// to be an empty 200 on those routes, and a wide range one unpaged select
// PostgREST silently cuts at 1,000 rows.

import { isRealCalendarDate } from '@/lib/schemas'
import { addDaysISO } from '@/lib/dublin-time'

export const MAX_REPORT_DAYS = 366

// RANGEVALID.1 — the live schedule feeds' cap (blocks, shifts, offers): the
// availability and change-log routes' figure. The calendar asks for at most 42
// days, and 92 days of Stillorgan is ≤ 468 blocks / ≤ 702 assignments, under
// PostgREST's silent 1,000-row cap.
export const MAX_LIST_RANGE_DAYS = 92

const DAY_MS = 86400000
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** Inclusive day count of a real, ordered period (UTC arithmetic, so no DST hour). */
function spanDays(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1
}

/**
 * The reason a period is refused, or null when it is fine: both ends real
 * calendar dates, end on or after start, at most `maxDays` days (inclusive).
 * `startName`/`endName` let a caller whose parameters are called something
 * else (the attendance report's from/to) say so; `maxDays`/`what` let a caller
 * with a tighter cap or its own noun (RANGEVALID.1: 'A roster', 'The overview')
 * say that. The defaults are the reports rule, unchanged.
 */
export function reportPeriodError(start, end, {
  startName = 'period_start', endName = 'period_end', maxDays = MAX_REPORT_DAYS, what = 'A report',
} = {}) {
  if (!isRealCalendarDate(start) || !isRealCalendarDate(end)) {
    return `${startName} and ${endName} must be real dates, YYYY-MM-DD`
  }
  if (end < start) return `${endName} must be on or after ${startName}`
  if (spanDays(start, end) > maxDays) return `${what} can cover at most ${maxDays} days`
  return null
}

/**
 * RANGEVALID.1 — the same rule for a list route whose bounds are each OPTIONAL
 * (absent or empty = no bound, as every such route has always read them). A
 * bound that is given must be a real date, refused in DATECHECK.1's words
 * (`<name>: not a real date`); when BOTH are given they go through
 * reportPeriodError: in order, at most `maxDays` days. A lone bound has no
 * span to judge. Returns the refusal sentence, or null.
 */
export function rangeQueryError(start, end, {
  startName = 'start_date', endName = 'end_date', maxDays = MAX_REPORT_DAYS, what = 'The range',
} = {}) {
  for (const [name, value] of [[startName, start], [endName, end]]) {
    if (value && !isRealCalendarDate(value)) return `${name}: not a real date`
  }
  if (start && end) return reportPeriodError(start, end, { startName, endName, maxDays, what })
  return null
}

/**
 * Every calendar day from `from` to `to` inclusive, as YYYY-MM-DD strings.
 * Belt and braces behind reportPeriodError: it stops at a step that is no
 * longer a four-digit-year date (past 9999-12-31) and after MAX_REPORT_DAYS
 * days, so it terminates whatever it is handed.
 */
export function* eachReportDay(from, to) {
  let ds = from
  for (let n = 0; n < MAX_REPORT_DAYS && typeof ds === 'string' && ISO_DAY.test(ds) && ds <= to; n++) {
    yield ds
    ds = addDaysISO(ds, 1)
  }
}
