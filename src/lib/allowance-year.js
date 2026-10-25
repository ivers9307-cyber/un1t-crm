// RANGEVALID.1 — the one rule for a holiday-allowance year, shared by
// GET/PUT /api/schedule/allowances and the staff assistant's
// get_holiday_allowance tool. staff_allowances.year is an integer column: a
// year that is not four digits reached Postgres as text ('abc' → 22P02,
// answered with the database's own message), and a far year (99999) answered
// a made-up entitlement. The window is the one the PUT already enforced.

import { todayStrIn, DEFAULT_TZ } from '@/lib/location-time'

export const ALLOWANCE_YEAR_MIN = 2020
export const ALLOWANCE_YEAR_MAX = 2100
export const ALLOWANCE_YEAR_ERROR = `year must be a four-digit year from ${ALLOWANCE_YEAR_MIN} to ${ALLOWANCE_YEAR_MAX}`

/**
 * This year on the studio's calendar (never the server's clock). TZ.8b: the
 * leave year turns at the studio's own midnight; `zone` is the studio's
 * (locations.timezone), DEFAULT_TZ when the caller has none.
 */
export function allowanceYearIn(zone = DEFAULT_TZ, nowMs = Date.now()) {
  return Number(todayStrIn(zone, nowMs).slice(0, 4))
}

/**
 * The allowance year as a number, or the reason it is refused. Accepts an
 * integer, or a string of exactly four digits (a query param). Absent (null,
 * undefined, '') means this year on the studio's calendar (`zone`).
 * @param {unknown} raw
 * @param {string} [zone] the studio's IANA zone (DEFAULT_TZ when omitted)
 * @returns {{ year: number|null, error: string|null }}
 */
export function parseAllowanceYear(raw, zone = DEFAULT_TZ) {
  if (raw === null || raw === undefined || raw === '') return { year: allowanceYearIn(zone), error: null }
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : ''
  if (!/^\d{4}$/.test(text)) return { year: null, error: ALLOWANCE_YEAR_ERROR }
  const year = Number(text)
  if (year < ALLOWANCE_YEAR_MIN || year > ALLOWANCE_YEAR_MAX) return { year: null, error: ALLOWANCE_YEAR_ERROR }
  return { year, error: null }
}
