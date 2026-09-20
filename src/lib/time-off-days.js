// ROSTER-FIX.2 — leave-day maths shared by the time-off POST.
// A holiday is charged for WORKING days only: Mon-Fri, and (HOLIDAYLEAVE.1)
// not a national bank holiday or one of the studio's own closures. Other leave
// types count calendar days.
//
// This is the ALLOWANCE count. It is deliberately not the same question as
// leaveHoursInWeek (roster-summary.js), which asks how many contracted hours a
// person is unavailable for and so keeps counting a bank holiday inside leave.
import { mergeHolidays } from './bank-holidays'

function addDay(iso) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10)
}

/**
 * Pure. Days of allowance [startIso, endIso] costs, both ends inclusive.
 *
 * @param {string} type  time_off_requests.type
 * @param {string} startIso  YYYY-MM-DD
 * @param {string} endIso    YYYY-MM-DD
 * @param {Set<string>|null} [nonWorkingDates]  HOLIDAYLEAVE.1 — YYYY-MM-DD
 *   dates that cost no allowance (nonWorkingDateSet). Only consulted for
 *   `holiday`. Pre-fetched by the caller so this stays pure and synchronous.
 */
export function countLeaveDays(type, startIso, endIso, nonWorkingDates = null) {
  let n = 0
  for (let cur = startIso; cur <= endIso; cur = addDay(cur)) {
    if (type !== 'holiday') { n++; continue }
    const dow = new Date(cur + 'T00:00:00Z').getUTCDay()
    if (dow < 1 || dow > 5) continue
    if (nonWorkingDates && nonWorkingDates.has(cur)) continue
    n++
  }
  return n
}

/**
 * HOLIDAYLEAVE.1 — pure. The dates in [start, end] that are a national bank
 * holiday for `country` (static list, bank-holidays.js) or one of the studio's
 * own location_holidays rows. mergeHolidays already de-duplicates by date and
 * applies the range; a country it has no static list for contributes no
 * national dates, so only the studio's own closures remain.
 *
 * @param {object} args
 * @param {string} [args.country]  ISO 3166-1 alpha-2 (locations.country). Default 'IE'.
 * @param {Array<{ date: string }>} [args.customHolidays]  location_holidays rows
 * @param {string} args.start  YYYY-MM-DD
 * @param {string} args.end    YYYY-MM-DD
 * @returns {Set<string>}
 */
export function nonWorkingDateSet({ country = 'IE', customHolidays = [], start, end }) {
  return new Set(mergeHolidays(customHolidays, { start, end, country }).map((h) => h.date))
}
// ROSTER-FIX.2 — a range can straddle more than one 31 December, and the
// single-cut version returned a SECOND segment that still spanned years, so
// every day after the first new year was charged to one allowance. Peel one
// year at a time until what is left sits inside a single year. The `<`
// comparison (not `!==`) also terminates on an inverted range.
export function splitAtYearEnd(startIso, endIso) {
  const out = []
  let cur = startIso
  while (cur.slice(0, 4) < endIso.slice(0, 4)) {
    const y = Number(cur.slice(0, 4))
    out.push([cur, `${y}-12-31`])
    cur = `${y + 1}-01-01`
  }
  out.push([cur, endIso])
  return out
}
