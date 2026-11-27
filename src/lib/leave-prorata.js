// @ts-check
// LEAVEPRORATA.1 — a holiday allowance for a year someone only worked part of.
//
// The allowance used to be the whole contract entitlement whatever the dates:
// a coach who started on 1 September and leaves on 14 December was shown 20
// days for the year when he had earned under six. The rule, decided by
// Richard on 27 Nov 2026:
//
//   allowance = entitlement × (calendar days employed in the year
//                              ÷ calendar days in the year),
//   rounded to the nearest half day.
//
// "Employed" runs from profile_compensation.employment_start_date to
// employment_end_date, both inclusive; either may be unset (open). A year the
// person worked whole is the entitlement exactly, never rounded. A year they
// did not work at all is 0.
//
// The SQL twin is public.prorated_leave_days (mig 877), used by the approval
// trigger's fallback seed and the mig 877 backfill. Change both together.
//
// Pure: no database, no clock.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

/** @param {unknown} iso @returns {number|null} days since the epoch, UTC */
function dayNumber(iso) {
  if (typeof iso !== 'string') return null
  const m = ISO.exec(iso.slice(0, 10))
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : null
}

/** @param {number} year */
function yearBounds(year) {
  const first = Math.round(Date.UTC(year, 0, 1) / 86400000)
  const last = Math.round(Date.UTC(year, 11, 31) / 86400000)
  return { first, last, length: last - first + 1 }
}

/**
 * Calendar days of `year` the person was employed, start and end inclusive.
 * An unset or unreadable date is open on that side.
 * @param {number} year
 * @param {string|null|undefined} startIso
 * @param {string|null|undefined} endIso
 */
export function employedDaysInYear(year, startIso, endIso) {
  const { first, last, length } = yearBounds(year)
  const start = dayNumber(startIso)
  const end = dayNumber(endIso)
  const from = start === null ? first : Math.max(first, start)
  const to = end === null ? last : Math.min(last, end)
  return { employed: Math.max(0, to - from + 1), length }
}

/**
 * Nearest half day; halves round up (5.25 → 5.5, 5.75 → 6).
 * @param {number} n
 */
export function roundToHalfDay(n) {
  return Math.round(n * 2 + 1e-9) / 2
}

/**
 * The year's holiday allowance in days.
 * @param {number} entitlement  the contract's days a year
 * @param {number} year
 * @param {string|null|undefined} startIso  employment_start_date
 * @param {string|null|undefined} endIso    employment_end_date
 * @returns {number}
 */
export function proratedEntitlementDays(entitlement, year, startIso, endIso) {
  const ent = Number(entitlement)
  if (!Number.isFinite(ent) || ent <= 0) return Number.isFinite(ent) && ent === 0 ? 0 : ent
  const { employed, length } = employedDaysInYear(year, startIso, endIso)
  if (employed >= length) return ent
  if (employed <= 0) return 0
  return roundToHalfDay((ent * employed) / length)
}

/**
 * The years whose saved allowance a change of dates can move: the years of
 * the old and new start and end dates, and `currentYear`. Sorted, unique.
 * @param {{ start?: string|null, end?: string|null }[]} dateSets
 * @param {number} currentYear
 */
export function yearsTouchedByDates(dateSets, currentYear) {
  const years = new Set([currentYear])
  for (const d of dateSets) {
    for (const iso of [d?.start, d?.end]) {
      if (typeof iso === 'string' && ISO.test(iso.slice(0, 10))) years.add(Number(iso.slice(0, 4)))
    }
  }
  return [...years].sort((a, b) => a - b)
}
