// Pure payroll math used by both the schedule calendar (overtime warning) and
// the staff_cost report (cost breakdown). Keep this dependency-free and
// side-effect-free so it's easy to unit-test and reuse.
//
// Overtime model:
//   - Applies to FTE staff only. Contractors are out of scope.
//   - Weekly threshold = profile.contracted_hours_per_week.
//   - For a given Mon-Sun week, hours up to the threshold are "regular",
//     anything above is "overtime".
//   - Overtime hours pay at profile.overtime_rate. If overtime_rate is null,
//     they pay at the regular implicit hourly rate (no premium).
//   - Daily overtime is NOT modelled — only weekly.
//
// Time format expected:
//   shifts: array of objects with `start_time` (HH:MM[:SS]) and `end_time`
//   (HH:MM[:SS]). Optional override fields take precedence:
//   start_time_override / end_time_override.

/**
 * Convert a HH:MM[:SS] string to fractional hours since midnight.
 * Returns null if the input is missing or malformed.
 */
export function timeToHours(t) {
  if (!t || typeof t !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t)
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  const ss = m[3] ? Number(m[3]) : 0
  if (h > 23 || mm > 59 || ss > 59) return null
  return h + mm / 60 + ss / 3600
}

/**
 * Compute the duration of a single shift in hours.
 * Honours start_time_override / end_time_override when set.
 * Treats overnight shifts (end < start) as crossing midnight.
 *
 * @param {object} shift  A shift row joined with its shift_template.
 * @returns {number} duration in hours, 0 if either time is missing/malformed.
 */
export function shiftHours(shift) {
  if (!shift) return 0
  const tpl = shift.shift_templates || shift.shift_template || {}
  const start = shift.start_time_override || tpl.start_time || shift.start_time
  const end   = shift.end_time_override   || tpl.end_time   || shift.end_time
  const s = timeToHours(start)
  const e = timeToHours(end)
  if (s == null || e == null) return 0
  let dur = e - s
  if (dur < 0) dur += 24  // overnight shift
  return dur
}

/**
 * Compute the implicit regular hourly rate for an FTE profile.
 * Returns 0 if any required field is missing or zero.
 */
export function implicitHourlyRate(profile) {
  if (!profile) return 0
  if (profile.employment_type === 'contractor') return Number(profile.hourly_rate) || 0
  const salary = Number(profile.annual_salary) || 0
  const weeklyHours = Number(profile.contracted_hours_per_week) || 0
  if (salary <= 0 || weeklyHours <= 0) return 0
  return salary / 52 / weeklyHours
}

/**
 * Compute regular vs overtime cost for a single staff member's shifts in a
 * single Mon-Sun week.
 *
 * For multi-week periods, callers should partition shifts by week first and
 * call this once per (staff, week) pair, then sum the results.
 *
 * @param {object} args
 * @param {object[]} args.shifts  Shifts already filtered to one week + one staff.
 * @param {object} args.profile   The staff member's profile row.
 * @returns {{
 *   actual_hours: number,
 *   contracted_hours: number,
 *   regular_hours: number,
 *   overtime_hours: number,
 *   regular_rate: number,
 *   overtime_rate: number,
 *   regular_cost: number,
 *   overtime_cost: number,
 *   total_cost: number,
 *   over_threshold: boolean,
 * }}
 */
export function computeWeeklyCost({ shifts, profile }) {
  const actual = (shifts || []).reduce((sum, s) => sum + shiftHours(s), 0)
  const contracted = Number(profile?.contracted_hours_per_week) || 0
  const regularRate = implicitHourlyRate(profile)
  // For OT rate, prefer the explicit profile.overtime_rate. If null/0,
  // fall back to the regular rate so the math stays correct (no premium).
  const otRateRaw = Number(profile?.overtime_rate)
  const overtimeRate = otRateRaw > 0 ? otRateRaw : regularRate

  // Contractors don't have a contracted threshold — treat all hours as regular.
  if (profile?.employment_type === 'contractor' || contracted <= 0) {
    const total = actual * regularRate
    return {
      actual_hours: round1(actual),
      contracted_hours: 0,
      regular_hours: round1(actual),
      overtime_hours: 0,
      regular_rate: round2(regularRate),
      overtime_rate: round2(regularRate),
      regular_cost: round2(total),
      overtime_cost: 0,
      total_cost: round2(total),
      over_threshold: false,
    }
  }

  const regularHours = Math.min(actual, contracted)
  const overtimeHours = Math.max(0, actual - contracted)
  const regularCost = regularHours * regularRate
  const overtimeCost = overtimeHours * overtimeRate

  return {
    actual_hours: round1(actual),
    contracted_hours: contracted,
    regular_hours: round1(regularHours),
    overtime_hours: round1(overtimeHours),
    regular_rate: round2(regularRate),
    overtime_rate: round2(overtimeRate),
    regular_cost: round2(regularCost),
    overtime_cost: round2(overtimeCost),
    total_cost: round2(regularCost + overtimeCost),
    over_threshold: overtimeHours > 0,
  }
}

/**
 * Group an array of shifts by their Mon-Sun ISO week start date (YYYY-MM-DD).
 * The week start is always a Monday in UTC.
 *
 * @param {object[]} shifts  Each must have a `shift_date` (YYYY-MM-DD).
 * @returns {Map<string, object[]>}  Map of weekStartIso → shifts in that week.
 */
export function groupShiftsByWeek(shifts) {
  const map = new Map()
  for (const s of shifts || []) {
    const date = s.shift_date
    if (!date) continue
    const monday = mondayOf(date)
    if (!map.has(monday)) map.set(monday, [])
    map.get(monday).push(s)
  }
  return map
}

/**
 * Return the Monday of the ISO week containing the given YYYY-MM-DD date.
 * In UTC. (The schedule already treats Mon as week start.)
 */
export function mondayOf(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z')
  const dow = d.getUTCDay()                 // 0 (Sun) .. 6 (Sat)
  const offset = dow === 0 ? -6 : 1 - dow   // shift back to Monday
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

function round1(n) { return Math.round(n * 10) / 10 }
function round2(n) { return Math.round(n * 100) / 100 }
