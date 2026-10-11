// TZ.8b — FROZEN copies of the time-off, attendance, contract, equipment and
// qualification code as it was before the sweep made it take the studio's
// zone. Test-only: the byte-identity tests in tz-8b.tz.test.js diff the new
// code (zone = 'Europe/Dublin') against these. Do not edit; TZ.18b deletes
// this file.
import { dublinTodayStr, dublinDayStr, dublinTimeLabel, dublinDateKey, addDaysISO } from '@/lib/dublin-time'
import { formatEuro } from '@/lib/contracts'
import { formatFullDateTimeInTZ } from '@/lib/dates'
import { mondayOf } from '@/lib/payroll'

// ── src/lib/allowance-year.js ──────────────────────────────────────────────
const ALLOWANCE_YEAR_MIN = 2020
const ALLOWANCE_YEAR_MAX = 2100
const ALLOWANCE_YEAR_ERROR = `year must be a four-digit year from ${ALLOWANCE_YEAR_MIN} to ${ALLOWANCE_YEAR_MAX}`
export function dublinYearLegacy() {
  return Number(dublinTodayStr().slice(0, 4))
}
export function parseAllowanceYearLegacy(raw) {
  if (raw === null || raw === undefined || raw === '') return { year: dublinYearLegacy(), error: null }
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : ''
  if (!/^\d{4}$/.test(text)) return { year: null, error: ALLOWANCE_YEAR_ERROR }
  const year = Number(text)
  if (year < ALLOWANCE_YEAR_MIN || year > ALLOWANCE_YEAR_MAX) return { year: null, error: ALLOWANCE_YEAR_ERROR }
  return { year, error: null }
}

// ── src/lib/time-off-cancel.js ─────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function dublinRetryLabelLegacy(iso) {
  const time = dublinTimeLabel(iso)
  if (!time) return null
  const [, m, d] = dublinDateKey(iso).split('-').map(Number)
  return `${time} on ${d} ${MONTHS[m - 1]}`
}

// ── src/lib/contracts.js ───────────────────────────────────────────────────
export function profileVariablesLegacy(profile) {
  if (!profile) return {}
  const v = {}
  if (profile.full_name) v.full_name = String(profile.full_name)
  if (profile.email) v.email = String(profile.email)
  if (profile.role) v.role = String(profile.role)
  if (profile.employment_type) v.employment_type = String(profile.employment_type)
  if (profile.annual_salary != null) {
    v.annual_salary_raw = String(profile.annual_salary)
    v.annual_salary = formatEuro(profile.annual_salary)
  }
  if (profile.hourly_rate != null) {
    v.hourly_rate_raw = String(profile.hourly_rate)
    v.hourly_rate = formatEuro(profile.hourly_rate)
  }
  if (profile.overtime_rate != null) {
    v.overtime_rate_raw = String(profile.overtime_rate)
    v.overtime_rate = formatEuro(profile.overtime_rate)
  }
  if (profile.contracted_hours_per_week != null) {
    v.contracted_hours_per_week = String(profile.contracted_hours_per_week)
  }
  v.today = dublinTodayStr()
  return v
}

// ── src/lib/contract-pdf.js signatureColumn's timestamp ────────────────────
export function signatureWhenLegacy(timestamp) {
  return formatFullDateTimeInTZ(timestamp, 'Europe/Dublin')
}

// ── contractor-invoice-email.js / contracts-email.js (the implicit default) ─
export function emailStampLegacy(value) {
  return formatFullDateTimeInTZ(value)
}

// ── src/lib/qualification-digest.js runQualificationDigest's day + keys ─────
export function qualificationDigestDayLegacy(nowMs) {
  return dublinDayStr(nowMs)
}
export function qualificationDigestKeysLegacy(organizationId, nowMs) {
  const todayISO = dublinDayStr(nowMs)
  const weekStart = mondayOf(todayISO)
  const eventKey = `qualification_digest:${organizationId}:${weekStart}`
  return { todayISO, weekStart, eventKey, attemptKey: `${eventKey}:d${todayISO}`, cutoff: addDaysISO(todayISO, 30) }
}

// ── every route's "today" (dublinTodayStr at the call) ─────────────────────
export const routeTodayLegacy = () => dublinTodayStr()
