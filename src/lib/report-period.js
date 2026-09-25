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

import { isRealCalendarDate } from '@/lib/schemas'
import { addDaysISO } from '@/lib/dublin-time'

export const MAX_REPORT_DAYS = 366

const DAY_MS = 86400000
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** Inclusive day count of a real, ordered period (UTC arithmetic, so no DST hour). */
function spanDays(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1
}

/**
 * The reason a report period is refused, or null when it is fine: both ends
 * real calendar dates, end on or after start, at most MAX_REPORT_DAYS days.
 */
export function reportPeriodError(start, end) {
  if (!isRealCalendarDate(start) || !isRealCalendarDate(end)) {
    return 'period_start and period_end must be real dates, YYYY-MM-DD'
  }
  if (end < start) return 'period_end must be on or after period_start'
  if (spanDays(start, end) > MAX_REPORT_DAYS) return `A report can cover at most ${MAX_REPORT_DAYS} days`
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
