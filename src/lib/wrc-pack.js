// WRCPACK.1 — the Workplace Relations Commission inspection pack.
//
// WHAT. For one organisation (every one of its studios) and a date range
// (default: the last 12 months), two CSVs:
//   staff   one row per person who held a studio membership in the
//           organisation or worked a non-cancelled shift there in the range:
//           identity, employment type, role, first and last rostered date,
//           contracted hours and hourly rate, rostered hours (override-aware,
//           shiftHours), Sunday hours and shifts, weeks over contract and the
//           overtime hours above it, holiday / sick / other leave days taken
//           (approved requests, days charged inside the range), the holiday
//           allowance for `year`, whether a signed contract exists, and
//           whether the current Employee Handbook version has a view for them.
//   shifts  one row per shift assignment (cancelled ones included and
//           flagged): date, staff, studio, rostered and adjusted times, the
//           arrival stamp, Sunday flag. The timesheet detail.
//
// WHO IS IN IT. Everyone employed in the period, so FORMER staff are in:
// deactivated profiles and permanent-delete tombstones (mig 622) keep their
// shifts and leave, and a tombstone's role is roleAtDeletion(). The house
// rule on excludeTombstones() is for lists that OFFER people; this is a
// record of who worked, so it includes them on purpose.
//
// HOW IT READS. Every read pages with an explicit .order() + .range()
// (PostgREST caps a response at 1,000 rows whatever .limit() says) and a
// failed read fails the pack (never an empty CSV that reads as "nobody").
// Shifts come through fetchScheduledShiftRows (includeCancelled), leave
// through fetchOverlappingTimeOff + timeOffDaysInPeriod, so the figures agree
// with the Reporting tab's own reports for the same period.
//
// WHAT IT DOES NOT CLAIM. Rostered hours are the roster's paid window
// (override → block → template), not clocked time: arrived_at is the only
// arrival record and there is no departure stamp. A Sunday shift is one whose
// block date is a Sunday (an overnight Saturday shift counts as Saturday).
// Overtime is weekly (Mon–Sun, mondayOf), FTE only, against
// contracted_hours_per_week, like payroll.js; a week cut by the range edge is
// judged on the hours inside the range.
//
// LIEU.1 — the time-in-lieu ledger (staff_lieu_credits, mig 760) rides in:
// per person, the hours credited and taken inside the range and the running
// balance at `to`; per shift, the public holiday it fell on (the studio's
// country's calendar) and the lieu hours the ledger holds for it. The shift
// column is what was RECORDED, not a recount: a shift with no ledger row
// (not yet swept, or a contractor's) shows blank.

import { fetchScheduledShiftRows, fetchOverlappingTimeOff, timeOffDaysInPeriod } from '@/lib/report-generator'
import { shiftHours, implicitHourlyRate, mondayOf } from '@/lib/payroll'
import { effectiveShiftStart, effectiveShiftEnd } from '@shared/roster-month'
import { roleAtDeletion, isTombstone } from '@/lib/staff-tombstone'
import { getNonWorkingDates } from '@/lib/time-off-leave'
import { zoneOfLocation, instantToZonedParts } from '@/lib/location-time'
import { logWarn } from '@/lib/log'
import { getStaticHolidays } from '@/lib/bank-holidays'
import { readLieuLedgerForProfiles } from '@/lib/lieu-credits'

export const HANDBOOK_SLUG = 'employee-handbook'

const PAGE = 1000
// Ids per .in() — a year of ids on one URL was ~32KB on the attendance route.
const ID_CHUNK = 100

/** The organisation's row keys the pack reads, so the route's response can say so. */
export const WRC_STAFF_CSV_HEADER = Object.freeze([
  'Full name', 'Email', 'Status', 'Employment type', 'Role', 'Studios',
  'First rostered date', 'Last rostered date',
  'Contracted hours per week', 'Hourly rate',
  'Rostered shifts', 'Rostered hours', 'Sunday shifts', 'Sunday hours',
  'Weeks over contract', 'Overtime hours above contract',
  'Holiday days taken', 'Sick days taken', 'Other leave days taken',
  'Allowance year', 'Allowance total days', 'Allowance used days', 'Allowance carried over',
  'Signed contract', 'Contract signed at',
  'Handbook version', 'Handbook viewed',
  'Lieu hours credited', 'Lieu hours taken', 'Lieu hours balance',
])

export const WRC_SHIFT_CSV_HEADER = Object.freeze([
  'Date', 'Weekday', 'Sunday', 'Public holiday', 'Staff', 'Email', 'Studio', 'Shift',
  'Rostered start', 'Rostered end', 'Adjusted start', 'Adjusted end', 'Hours',
  'Arrived at (studio time)', 'Status', 'Cancelled', 'Lieu hours earned',
])

// ─── pure helpers ────────────────────────────────────────────────────────

/** A YYYY-MM-DD wall-clock date's weekday is zone-independent. */
export function isSunday(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay() === 0
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function weekdayOf(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return ''
  return WEEKDAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()]
}

export { defaultWrcPeriod } from '@/lib/wrc-pack-period'

function round1(n) { return Math.round(n * 10) / 10 }
function round2(n) { return Math.round(n * 100) / 100 }

function toHHMM(t) {
  if (!t || typeof t !== 'string') return ''
  return t.slice(0, 5)
}

function arrivalLocal(iso, zone) {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const p = instantToZonedParts(ms, zone)
  const pad = (n) => String(n).padStart(2, '0')
  return `${p.dateKey} ${pad(p.h)}:${pad(p.mi)}`
}

function profileStatus(p) {
  if (isTombstone(p)) return `deleted ${String(p.deleted_at).slice(0, 10)}`
  return p?.active === false ? 'inactive' : 'active'
}

/** The hourly rate the pack reports: a contractor's own rate, else the salary-implied rate. */
export function wrcHourlyRate(profile) {
  const r = implicitHourlyRate(profile)
  return r > 0 ? round2(r) : null
}

/**
 * Pure. Builds both row sets from rows already read.
 *
 * @param {object} args
 * @param {Array<object>} args.profiles  profiles rows (id, full_name, email, role, deleted_role, deleted_at, active, employment_type, annual_salary, hourly_rate, contracted_hours_per_week)
 * @param {Array<{ profile_id: string, location_id: string, role: string|null }>} args.memberships  profile_locations rows at the org's studios
 * @param {Array<object>} args.shifts  fetchScheduledShiftRows rows (includeCancelled) across the org's studios
 * @param {Array<object>} args.timeOff  approved time_off_requests overlapping the range
 * @param {Array<object>} args.allowances  staff_allowances rows for `year`
 * @param {Array<{ profile_id: string, signed_at: string|null }>} args.contracts  signed contracts in the org
 * @param {{ version: number|null, viewedProfileIds: Set<string> }|null} args.handbook
 * @param {Record<string, { name: string, zone: string }>} args.locationsById
 * @param {Record<string, Set<string>|null>} args.nonWorkingByLocation  HOLIDAYLEAVE.1 dates per studio (null = unknown)
 * @param {Array<object>} [args.lieuRows]  staff_lieu_credits rows dated on or before `to` (LIEU.1)
 * @param {Record<string, Map<string,string>>} [args.holidaysByLocation]  location id → Map(date → public holiday name)
 * @param {string} args.from  YYYY-MM-DD
 * @param {string} args.to    YYYY-MM-DD
 * @param {number} args.year  the allowance year reported
 */
export function buildWrcPack({
  profiles, memberships, shifts, timeOff, allowances, contracts, handbook,
  locationsById, nonWorkingByLocation = {}, lieuRows = [], holidaysByLocation = {}, from, to, year,
}) {
  const profileById = new Map()
  for (const p of profiles || []) if (p?.id) profileById.set(p.id, p)

  const memberRolesById = new Map()      // profile_id → Map(location_id → role)
  for (const m of memberships || []) {
    if (!m?.profile_id) continue
    if (!memberRolesById.has(m.profile_id)) memberRolesById.set(m.profile_id, new Map())
    memberRolesById.get(m.profile_id).set(m.location_id, m.role || null)
  }

  const live = (shifts || []).filter((s) => s.status !== 'cancelled')
  const worked = new Set(live.map((s) => s.profile_id).filter(Boolean))

  // The population: a membership in the org, or a live shift in the range.
  const ids = new Set([...memberRolesById.keys(), ...worked])

  // Per-person shift aggregates.
  const agg = new Map()
  const emptyAgg = () => ({
    shifts: 0, hours: 0, sundayShifts: 0, sundayHours: 0, first: null, last: null, weeks: new Map(), studios: new Set(),
  })
  for (const s of live) {
    if (!s.profile_id) continue
    if (!agg.has(s.profile_id)) agg.set(s.profile_id, emptyAgg())
    const a = agg.get(s.profile_id)
    const h = shiftHours(s)
    a.shifts += 1
    a.hours += h
    if (isSunday(s.shift_date)) { a.sundayShifts += 1; a.sundayHours += h }
    if (s.shift_date) {
      if (!a.first || s.shift_date < a.first) a.first = s.shift_date
      if (!a.last || s.shift_date > a.last) a.last = s.shift_date
      const wk = mondayOf(s.shift_date)
      a.weeks.set(wk, (a.weeks.get(wk) || 0) + h)
    }
    if (s.location_id) a.studios.add(s.location_id)
  }

  // Leave: approved requests, days charged inside the range.
  const leave = new Map()                // profile_id → { holiday, sick, other }
  for (const r of timeOff || []) {
    if (!r?.profile_id || r.status !== 'approved') continue
    if (!leave.has(r.profile_id)) leave.set(r.profile_id, { holiday: 0, sick: 0, other: 0 })
    const bucket = r.type === 'holiday' ? 'holiday' : r.type === 'sick' ? 'sick' : 'other'
    const nonWorking = nonWorkingByLocation[r.location_id] ?? null
    const { days } = timeOffDaysInPeriod(r, from, to, nonWorking)
    leave.get(r.profile_id)[bucket] += days
  }

  const allowanceById = new Map()
  for (const a of allowances || []) if (a?.profile_id && Number(a.year) === Number(year)) allowanceById.set(a.profile_id, a)

  // LIEU.1 — per person: credited and taken inside [from, to], balance at `to`.
  const lieuById = new Map()             // profile_id → { credited, taken, balance }
  const lieuByAssignment = new Map()     // shift_assignment_id → hours
  for (const r of lieuRows || []) {
    if (!r?.profile_id) continue
    const h = Number(r.hours)
    if (!Number.isFinite(h)) continue
    if (!r.credit_date || r.credit_date > to) continue
    if (!lieuById.has(r.profile_id)) lieuById.set(r.profile_id, { credited: 0, taken: 0, balance: 0 })
    const l = lieuById.get(r.profile_id)
    l.balance += h
    if (r.credit_date >= from) {
      if (r.source === 'taken' || h < 0) l.taken += -h
      else l.credited += h
    }
    if (r.shift_assignment_id) lieuByAssignment.set(r.shift_assignment_id, h)
  }

  const contractById = new Map()         // latest signed_at per profile
  for (const c of contracts || []) {
    if (!c?.profile_id || !c.signed_at) continue
    const prev = contractById.get(c.profile_id)
    if (!prev || c.signed_at > prev) contractById.set(c.profile_id, c.signed_at)
  }

  const staff = []
  for (const id of ids) {
    const p = profileById.get(id) || { id, full_name: null, email: null }
    const a = agg.get(id) || emptyAgg()
    const roles = memberRolesById.get(id)
    const memberStudios = roles ? [...roles.keys()] : []
    const studioIds = new Set([...memberStudios, ...a.studios])
    const roleText = roles && roles.size > 0
      ? [...new Set([...roles.values()].filter(Boolean))].join('; ')
      : (roleAtDeletion(p) || p.role || '')

    const contracted = p.employment_type === 'fte' ? (Number(p.contracted_hours_per_week) || 0) : 0
    let weeksOver = 0
    let overtime = 0
    if (contracted > 0) {
      for (const h of a.weeks.values()) {
        if (h > contracted) { weeksOver += 1; overtime += h - contracted }
      }
    }

    const lv = leave.get(id) || { holiday: 0, sick: 0, other: 0 }
    const al = allowanceById.get(id) || null
    const signedAt = contractById.get(id) || null
    const handbookViewed = handbook?.version == null ? null : handbook.viewedProfileIds.has(id)

    staff.push({
      profile_id: id,
      full_name: p.full_name || '',
      email: p.email || '',
      status: profileStatus(p),
      employment_type: p.employment_type || '',
      role: roleText,
      studios: [...studioIds].map((lid) => locationsById[lid]?.name || lid).sort().join('; '),
      first_shift_date: a.first,
      last_shift_date: a.last,
      contracted_hours_per_week: p.employment_type === 'fte' && p.contracted_hours_per_week != null ? Number(p.contracted_hours_per_week) : null,
      hourly_rate: wrcHourlyRate(p),
      rostered_shifts: a.shifts,
      rostered_hours: round1(a.hours),
      sunday_shifts: a.sundayShifts,
      sunday_hours: round1(a.sundayHours),
      weeks_over_contract: contracted > 0 ? weeksOver : null,
      overtime_hours: contracted > 0 ? round1(overtime) : null,
      holiday_days: lv.holiday,
      sick_days: lv.sick,
      other_leave_days: lv.other,
      allowance_year: year,
      allowance_total_days: al ? Number(al.total_days) : null,
      allowance_used_days: al ? Number(al.used_days) : null,
      allowance_carried_over: al ? Number(al.carried_over) : null,
      contract_signed: Boolean(signedAt),
      contract_signed_at: signedAt,
      handbook_version: handbook?.version ?? null,
      handbook_viewed: handbookViewed,
      lieu_hours_credited: round2(lieuById.get(id)?.credited || 0),
      lieu_hours_taken: round2(lieuById.get(id)?.taken || 0),
      lieu_hours_balance: round2(lieuById.get(id)?.balance || 0),
    })
  }
  staff.sort((x, y) => (x.full_name || '').localeCompare(y.full_name || '') || x.profile_id.localeCompare(y.profile_id))

  const shiftRows = (shifts || []).map((s) => {
    const p = profileById.get(s.profile_id) || s.profiles || {}
    const loc = locationsById[s.location_id] || null
    const rosteredStart = s.block_start_time ?? s.shift_templates?.start_time ?? null
    const rosteredEnd = s.block_end_time ?? s.shift_templates?.end_time ?? null
    const cancelled = s.status === 'cancelled'
    const lieuEarned = s.assignment_id != null && lieuByAssignment.has(s.assignment_id) ? round2(lieuByAssignment.get(s.assignment_id)) : null
    return {
      assignment_id: s.assignment_id ?? null,
      date: s.shift_date,
      weekday: weekdayOf(s.shift_date),
      sunday: isSunday(s.shift_date),
      public_holiday: holidaysByLocation[s.location_id]?.get(s.shift_date) || '',
      lieu_hours_earned: lieuEarned,
      profile_id: s.profile_id,
      full_name: p.full_name || s.profiles?.full_name || '',
      email: p.email || '',
      studio: loc?.name || s.location_id || '',
      shift: s.shift_templates?.name || '',
      rostered_start: toHHMM(rosteredStart),
      rostered_end: toHHMM(rosteredEnd),
      adjusted_start: toHHMM(effectiveShiftStart(s)),
      adjusted_end: toHHMM(effectiveShiftEnd(s)),
      hours: cancelled ? 0 : round2(shiftHours(s)),
      arrived_at: s.arrived_at || null,
      arrived_local: arrivalLocal(s.arrived_at, loc?.zone),
      status: s.status || '',
      cancelled,
    }
  })
  shiftRows.sort((x, y) => (x.date || '').localeCompare(y.date || '')
    || x.adjusted_start.localeCompare(y.adjusted_start)
    || x.full_name.localeCompare(y.full_name))

  return { staff, shifts: shiftRows }
}

// ─── CSV ─────────────────────────────────────────────────────────────────

// Quoted when it holds a quote, comma or line break.
function csvCell(s) {
  const v = String(s ?? '')
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

// A free-text cell (a name, an email, a role). One that starts with = + - @, a
// tab or a CR is one a spreadsheet may run as a formula, so it gets a leading
// ' (the OWASP CSV-injection defence). Numbers and dates are not text cells.
function csvText(s) {
  const v = String(s ?? '')
  return csvCell(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v)
}

const yesNo = (v) => (v === null || v === undefined ? '' : v ? 'yes' : 'no')
const num = (v) => (v === null || v === undefined ? '' : v)

export function wrcStaffCsv(rows) {
  const lines = [WRC_STAFF_CSV_HEADER.join(',')]
  for (const r of Array.isArray(rows) ? rows : []) {
    lines.push([
      csvText(r.full_name), csvText(r.email), csvText(r.status), csvText(r.employment_type), csvText(r.role), csvText(r.studios),
      r.first_shift_date || '', r.last_shift_date || '',
      num(r.contracted_hours_per_week), num(r.hourly_rate),
      r.rostered_shifts, r.rostered_hours, r.sunday_shifts, r.sunday_hours,
      num(r.weeks_over_contract), num(r.overtime_hours),
      r.holiday_days, r.sick_days, r.other_leave_days,
      r.allowance_year, num(r.allowance_total_days), num(r.allowance_used_days), num(r.allowance_carried_over),
      yesNo(r.contract_signed), r.contract_signed_at || '',
      num(r.handbook_version), yesNo(r.handbook_viewed),
      num(r.lieu_hours_credited), num(r.lieu_hours_taken), num(r.lieu_hours_balance),
    ].join(','))
  }
  return lines.join('\n')
}

export function wrcShiftCsv(rows) {
  const lines = [WRC_SHIFT_CSV_HEADER.join(',')]
  for (const r of Array.isArray(rows) ? rows : []) {
    lines.push([
      r.date || '', r.weekday, yesNo(r.sunday), csvText(r.public_holiday), csvText(r.full_name), csvText(r.email), csvText(r.studio), csvText(r.shift),
      r.rostered_start, r.rostered_end, r.adjusted_start, r.adjusted_end, r.hours,
      r.arrived_local, csvText(r.status), yesNo(r.cancelled), num(r.lieu_hours_earned),
    ].join(','))
  }
  return lines.join('\n')
}

// ─── reads ───────────────────────────────────────────────────────────────

/** Page a builder-producing function to the end. `make(from, to)` must apply .order() itself. */
async function pageAll(make) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1)
    if (error) return { rows: [], error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { rows, error: null }
}

function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

/** The current Employee Handbook version for the org and who has a view row on it. */
async function readHandbook(db, organizationId) {
  const { data: policy, error: pErr } = await db.from('policies')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('slug', HANDBOOK_SLUG)
    .maybeSingle()                         // (organization_id, slug) is unique (mig 713); 0 rows = no handbook
  if (pErr) return { handbook: null, error: `Failed to read the handbook policy: ${pErr.message}` }
  if (!policy) return { handbook: null, error: null }
  const { data: version, error: vErr } = await db.from('policy_versions')
    .select('id, version_number')
    .eq('policy_id', policy.id)
    .eq('is_current', true)
    .maybeSingle()                         // one is_current per policy (partial unique index, mig 178)
  if (vErr) return { handbook: null, error: `Failed to read the handbook version: ${vErr.message}` }
  if (!version) return { handbook: null, error: null }
  const { rows, error } = await pageAll((a, b) => db.from('policy_views')
    .select('profile_id')
    .eq('policy_version_id', version.id)
    .order('id')
    .range(a, b))
  if (error) return { handbook: null, error: `Failed to read handbook views: ${error.message}` }
  return {
    handbook: { version: version.version_number, viewedProfileIds: new Set(rows.map((r) => r.profile_id).filter(Boolean)) },
    error: null,
  }
}

/**
 * Reads everything the pack needs for one organisation and builds it.
 * @returns {Promise<{ pack: { staff: Array, shifts: Array }|null, locations: Array, error: string|null }>}
 */
export async function generateWrcPack(db, { organizationId, from, to, year }) {
  const { rows: locations, error: locErr } = await pageAll((a, b) => db.from('locations')
    .select('id, name, timezone, country')
    .eq('organization_id', organizationId)
    .order('id')
    .range(a, b))
  if (locErr) return { pack: null, locations: [], error: `Failed to read the organisation's studios: ${locErr.message}` }
  const locationIds = locations.map((l) => l.id)
  const locationsById = {}
  const holidaysByLocation = {}
  for (const l of locations) {
    locationsById[l.id] = { name: l.name, zone: zoneOfLocation(l) }
    // LIEU.1 — the studio's public-holiday calendar (static; 'IE' when unset).
    holidaysByLocation[l.id] = new Map(getStaticHolidays(from, to, l.country || 'IE').map((h) => [h.date, h.name]))
  }
  if (locationIds.length === 0) {
    return { pack: buildWrcPack({ profiles: [], memberships: [], shifts: [], timeOff: [], allowances: [], contracts: [], handbook: null, locationsById, holidaysByLocation, from, to, year }), locations, error: null }
  }

  const { rows: memberships, error: memErr } = await pageAll((a, b) => db.from('profile_locations')
    .select('profile_id, location_id, role')
    .in('location_id', locationIds)
    .order('id')
    .range(a, b))
  if (memErr) return { pack: null, locations, error: `Failed to read studio memberships: ${memErr.message}` }

  const shifts = []
  const timeOff = []
  const nonWorkingByLocation = {}
  for (const locationId of locationIds) {
    const { rows, error } = await fetchScheduledShiftRows(db, { locationId, periodStart: from, periodEnd: to, includeCancelled: true })
    if (error) return { pack: null, locations, error }
    shifts.push(...rows)

    const leave = await fetchOverlappingTimeOff(db, {
      locationId, periodStart: from, periodEnd: to, status: 'approved',
      select: 'id, profile_id, location_id, type, status, start_date, end_date, total_days',
    })
    if (leave.error) return { pack: null, locations, error: `Failed to read time off: ${leave.error}` }
    timeOff.push(...leave.rows)

    // HOLIDAYLEAVE.1 — only an edge-crossing holiday is recounted, and only
    // then are the studio's non-working dates consulted. An unreadable list is
    // logged and the recount falls back to Mon–Fri (a possible over-count of
    // a bank holiday on a cut request), never a failed pack.
    const nw = await getNonWorkingDates(db, locationId, from, to, { quiet: true })
    if (nw.error) {
      logWarn('wrc-pack', 'non-working dates unreadable; edge-crossing holidays counted Mon–Fri', { locationId, err: nw.error?.message })
      nonWorkingByLocation[locationId] = null
    } else {
      nonWorkingByLocation[locationId] = nw.dates
    }
  }

  const profileIds = [...new Set([
    ...memberships.map((m) => m.profile_id),
    ...shifts.map((s) => s.profile_id),
    ...timeOff.map((t) => t.profile_id),
  ].filter(Boolean))]

  const profiles = []
  const allowances = []
  for (const ids of chunk(profileIds, ID_CHUNK)) {
    const { rows, error } = await pageAll((a, b) => db.from('profiles')
      .select('id, full_name, email, role, deleted_role, deleted_at, active, employment_type, annual_salary, hourly_rate, contracted_hours_per_week')
      .in('id', ids)
      .order('id')
      .range(a, b))
    if (error) return { pack: null, locations, error: `Failed to read staff profiles: ${error.message}` }
    profiles.push(...rows)

    const al = await pageAll((a, b) => db.from('staff_allowances')
      .select('profile_id, year, total_days, used_days, carried_over')
      .in('profile_id', ids)
      .eq('year', year)
      .order('id')
      .range(a, b))
    if (al.error) return { pack: null, locations, error: `Failed to read holiday allowances: ${al.error.message}` }
    allowances.push(...al.rows)
  }

  const { rows: contracts, error: cErr } = await pageAll((a, b) => db.from('contracts')
    .select('profile_id, signed_at')
    .eq('organization_id', organizationId)
    .eq('status', 'signed')
    .order('id')
    .range(a, b))
  if (cErr) return { pack: null, locations, error: `Failed to read contracts: ${cErr.message}` }

  const { handbook, error: hErr } = await readHandbook(db, organizationId)
  if (hErr) return { pack: null, locations, error: hErr }

  // LIEU.1 — every ledger row of these people up to `to` (the running
  // balance needs the history; the period figures filter in buildWrcPack).
  const { rows: lieuRows, error: lieuErr } = await readLieuLedgerForProfiles(db, profileIds, { to })
  if (lieuErr) return { pack: null, locations, error: `Failed to read the lieu ledger: ${lieuErr.message}` }

  const pack = buildWrcPack({
    profiles, memberships, shifts, timeOff, allowances, contracts, handbook,
    locationsById, nonWorkingByLocation, lieuRows, holidaysByLocation, from, to, year,
  })
  return { pack, locations, error: null }
}
