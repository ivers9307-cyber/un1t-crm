// ROSTER-FIX.6c — the FTE weekly-hours panel, computed on the server.
//
// ScheduleCalendar ran computeWeeklyCost() in the BROWSER. To do that it needed
// annual_salary, hourly_rate, contracted_hours_per_week and overtime_rate for
// every coach at the location, which it got from /api/staff — so every manager
// who opened the roster held the studio's pay data in their tab, for a panel
// that prints no money at all. It renders "14.0h / 10h · +4.0h OT", and hours
// are the only thing it has ever needed.
//
// Same posture, and the same reasoning, as computeMonthlyContractorSpend in
// roster-summary-server.js: read the rates with the service-role client, do the
// arithmetic here, and let ONLY hours cross the wire. Nothing in the returned
// shape is a rate, a salary or a euro figure — pinned by a test that stringifies
// the whole result and greps it.
//
// Auth is the caller's responsibility (MANAGER_ROLES + location membership);
// this helper trusts its inputs.

import { computeWeeklyCost } from './payroll'
import { blocksToShiftRows } from './roster-summary'
import { addDays, formatDate, getMonday } from './roster'

/**
 * Parse a 'YYYY-MM-DD' as a LOCAL date. `new Date('2026-05-04')` is UTC
 * midnight, which is the previous day in any timezone west of UTC and the
 * wrong Monday in some. Same rule as formatDate's, in reverse.
 */
function parseLocalDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * Per-coach FTE hours for one Mon-Sun week at one location.
 *
 * `weekStart` is snapped to its Monday, so a caller that passes any day of the
 * week gets that week rather than a seven-day span starting mid-week — the
 * panel's copy says "for <week>" and the numbers have to match it.
 *
 * @param {object} args
 * @param {object} args.db          service-role Supabase client
 * @param {string} args.locationId  uuid
 * @param {string} args.weekStart   ISO date inside the target week
 * @returns {Promise<{
 *   weekStartIso: string,
 *   weekEndIso: string,
 *   coaches: Array<{
 *     profile_id: string, full_name: string,
 *     allocated_hours: number, contracted_hours: number, overtime_hours: number,
 *     status: 'under' | 'at_contract' | 'overtime',
 *     over_threshold: boolean,
 *   }>,
 *   totals: { coaches: number, allocated_hours: number, overtime_hours: number, over_threshold: number },
 * }>}
 */
export async function computeWeeklyFteHours({ db, locationId, weekStart }) {
  const monday = getMonday(parseLocalDate(weekStart))
  const startIso = formatDate(monday)
  const endIso = formatDate(addDays(monday, 6))

  const { data: blocks, error: blocksErr } = await db
    .from('shift_blocks')
    .select(`
      id, location_id, block_date, start_time, end_time,
      template_id, notes,
      shift_assignments(id, profile_id, status, notes, start_time_override, end_time_override),
      shift_templates(start_time, end_time, role_label)
    `)
    .eq('location_id', locationId)
    .gte('block_date', startIso)
    .lte('block_date', endIso)
  if (blocksErr) throw new Error(blocksErr.message)

  const { data: links, error: linksErr } = await db
    .from('profile_locations')
    .select('profile_id')
    .eq('location_id', locationId)
  if (linksErr) throw new Error(linksErr.message)
  const profileIds = (links || []).map((l) => l.profile_id)

  let staff = []
  if (profileIds.length > 0) {
    // The rates are read here and consumed in-memory. They never leave.
    const { data: profiles, error: profilesErr } = await db
      .from('profiles')
      .select(`
        id, full_name, active, employment_type,
        contracted_hours_per_week, hourly_rate, annual_salary, overtime_rate
      `)
      .in('id', profileIds)
    if (profilesErr) throw new Error(profilesErr.message)
    staff = profiles || []
  }

  const rows = blocksToShiftRows(blocks || [])

  const coaches = []
  for (const s of staff) {
    if (!s.active) continue
    // Same population the panel has always shown: FTE staff on a contract.
    // A contractor has no weekly threshold to be over, and an FTE on zero
    // contracted hours has no comparator, so neither has anything to report.
    if (s.employment_type !== 'fte') continue
    if (!(Number(s.contracted_hours_per_week) > 0)) continue

    const own = rows.filter((r) => r.profile_id === s.id)
    const cost = computeWeeklyCost({ shifts: own, profile: s })
    if (!(cost.actual_hours > 0)) continue
    // The panel only ever listed coaches at or above their contract; keeping
    // that filter here means the endpoint answers the question the screen asks
    // rather than shipping the whole roster's hours to be filtered in a tab.
    if (cost.actual_hours < cost.contracted_hours) {
      coaches.push(row(s, cost, 'under'))
      continue
    }
    coaches.push(row(s, cost, cost.over_threshold ? 'overtime' : 'at_contract'))
  }

  // Over-contract first, then the heaviest week — the order a manager scans in.
  const rank = { overtime: 0, at_contract: 1, under: 2 }
  coaches.sort((a, b) => (
    rank[a.status] - rank[b.status] || b.allocated_hours - a.allocated_hours
  ))

  return {
    weekStartIso: startIso,
    weekEndIso: endIso,
    coaches,
    totals: {
      coaches: coaches.length,
      allocated_hours: round1(coaches.reduce((sum, c) => sum + c.allocated_hours, 0)),
      overtime_hours: round1(coaches.reduce((sum, c) => sum + c.overtime_hours, 0)),
      over_threshold: coaches.filter((c) => c.over_threshold).length,
    },
  }
}

function row(profile, cost, status) {
  return {
    profile_id: profile.id,
    full_name: profile.full_name,
    allocated_hours: cost.actual_hours,
    contracted_hours: cost.contracted_hours,
    overtime_hours: cost.overtime_hours,
    status,
    over_threshold: cost.over_threshold,
  }
}

function round1(n) { return Math.round(n * 10) / 10 }
