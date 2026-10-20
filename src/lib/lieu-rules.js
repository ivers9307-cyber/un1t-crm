// LIEU.1 — the time-in-lieu rule, pure. Read by the nightly sweep
// (lieu-credits.js), the Staff Cost report and the location settings card.
//
// THE RULE (Richard, 20 Oct 2026; Organisation of Working Time Act 1997
// s.14 and s.21). FTE employees only — a contractor is paid per hour and
// earns no lieu time:
//   • a Sunday worked earns time in lieu at time and a third: the shift's
//     paid hours × the studio's Sunday multiplier (default 4/3). It is lieu
//     TIME, not a pay premium — the Staff Cost report prices Sunday hours at
//     the ordinary rate and reports the lieu hours beside them.
//   • a public holiday worked (the studio's country's calendar,
//     bank-holidays.js) earns base time in lieu: paid hours × 1.
//   • a public holiday that is also a Sunday earns the greater of the two,
//     once, recorded as public_holiday_worked at the Sunday multiplier.
//
// The multiplier lives in locations.settings.payroll.sunday_multiplier
// (operator-editable: Settings → Locations → <studio> → Payroll). A missing,
// malformed or out-of-range value is the default, never 0 and never 1 — a
// studio that forgot to set it still owes time and a third.

import { shiftHours } from '@/lib/payroll'

export const DEFAULT_SUNDAY_LIEU_MULTIPLIER = 4 / 3
export const SUNDAY_MULTIPLIER_MIN = 1
export const SUNDAY_MULTIPLIER_MAX = 3
export const PUBLIC_HOLIDAY_LIEU_MULTIPLIER = 1

export const LIEU_SOURCES = Object.freeze(['sunday_worked', 'public_holiday_worked', 'manual', 'taken'])
/** The sources a manager writes by hand; the other two are the sweep's. */
export const LIEU_MANUAL_SOURCES = Object.freeze(['manual', 'taken'])

export function round2(n) { return Math.round(n * 100) / 100 }
export function round4(n) { return Math.round(n * 10000) / 10000 }

/** A YYYY-MM-DD wall-clock date's weekday is zone-independent. */
export function isSundayDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay() === 0
}

/**
 * The Sunday lieu multiplier a studio's settings carry, or the default.
 * Pure. `settings` is locations.settings (jsonb) or null.
 */
export function sundayLieuMultiplier(settings) {
  const raw = settings?.payroll?.sunday_multiplier
  if (raw === null || raw === undefined || raw === '') return DEFAULT_SUNDAY_LIEU_MULTIPLIER
  const n = Number(raw)
  if (!Number.isFinite(n) || n < SUNDAY_MULTIPLIER_MIN || n > SUNDAY_MULTIPLIER_MAX) return DEFAULT_SUNDAY_LIEU_MULTIPLIER
  return n
}

/**
 * What one shift earns, or null when it earns nothing. Pure.
 *
 * @param {object} args
 * @param {object} args.shift  a fetchScheduledShiftRows row: shift_date,
 *   status, start/end overrides, block times, shift_templates, profiles
 *   { employment_type }. `employmentType` may be passed instead of the embed.
 * @param {string|null} [args.holidayName]  the public holiday the date is, if any
 * @param {number} [args.sundayMultiplier]
 * @param {string} [args.employmentType]
 * @returns {{ source: 'sunday_worked'|'public_holiday_worked', hours: number, worked_hours: number, multiplier: number, holiday_name: string|null }|null}
 */
export function lieuCreditForShift({ shift, holidayName = null, sundayMultiplier = DEFAULT_SUNDAY_LIEU_MULTIPLIER, employmentType } = {}) {
  if (!shift || shift.status === 'cancelled') return null
  const emp = employmentType ?? shift.profiles?.employment_type
  if (emp !== 'fte') return null
  const sunday = isSundayDate(shift.shift_date)
  const holiday = Boolean(holidayName)
  if (!sunday && !holiday) return null
  const worked = shiftHours(shift)
  if (!(worked > 0)) return null
  const multiplier = sunday
    ? Math.max(sundayMultiplier, holiday ? PUBLIC_HOLIDAY_LIEU_MULTIPLIER : 0)
    : PUBLIC_HOLIDAY_LIEU_MULTIPLIER
  const hours = round2(worked * multiplier)
  if (!(hours > 0)) return null
  return {
    source: holiday ? 'public_holiday_worked' : 'sunday_worked',
    hours,
    worked_hours: round2(worked),
    multiplier: round4(multiplier),
    holiday_name: holiday ? String(holidayName) : null,
  }
}

/**
 * The balance a ledger adds up to. Pure. Credits are positive rows, lieu
 * taken is negative (source 'taken'); the balance is the signed sum.
 * @param {Array<{ source: string, hours: number|string }>} rows
 */
export function lieuBalanceFrom(rows) {
  let credited = 0
  let taken = 0
  for (const r of rows || []) {
    const h = Number(r?.hours)
    if (!Number.isFinite(h)) continue
    if (r.source === 'taken' || h < 0) taken += -h
    else credited += h
  }
  return {
    credited_hours: round2(credited),
    taken_hours: round2(taken),
    balance_hours: round2(credited - taken),
  }
}
