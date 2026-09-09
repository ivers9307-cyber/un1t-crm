// Roster v2 phase 5 — publish helpers.
//
// projectPublishImpact: server-side function that given a
// location + publish period returns what the month-total
// contractor spend WILL be if this period is published, plus
// the budget delta. Drives the publish modal's "you'll be €X
// over budget" preview AND the API's hard gate for managers.
//
// publishRoster: creates a `rosters` row, tags blocks in the
// period with the roster_id, sets shifts.published=true via
// the legacy mirror so mobile/reports keep working.
//
// findConflictingPublishedRosters: the overlap guard. Lives here
// rather than in the POST route because BOTH ways a roster becomes
// published — POST /api/schedule/rosters and the approve endpoint
// flipping a draft — have to run it, and a guard that only one of
// them ran was no guard at all.

import { shiftHours } from './payroll'
import { liveAssignments } from './roster'

function isoFirstOfMonth(iso) {
  return `${iso.slice(0, 7)}-01`
}

function isoLastOfMonth(iso) {
  const [y, m] = iso.split('-').map(Number)
  // m is 1-12; new Date(y, m, 0) returns last day of month m.
  const last = new Date(Date.UTC(y, m, 0))
  return last.toISOString().slice(0, 10)
}

/**
 * Return the (location, contractor staff lookup, blocks-in-month
 * with roster join, current monthly_contractor_budget_eur) needed
 * to evaluate a publish.
 */
async function loadBudgetContext(db, locationId, periodStart) {
  const monthStart = isoFirstOfMonth(periodStart)
  const monthEnd = isoLastOfMonth(periodStart)

  // Location budget snapshot.
  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('id, monthly_contractor_budget_eur')
    .eq('id', locationId)
    .single()
  if (locErr) throw new Error(`Location lookup failed: ${locErr.message}`)

  // Contractor profiles assigned to this location with their rates.
  const { data: links, error: linksErr } = await db
    .from('profile_locations')
    .select('profile_id, profiles:profile_id(id, employment_type, hourly_rate, active)')
    .eq('location_id', locationId)
  if (linksErr) throw new Error(`Profile lookup failed: ${linksErr.message}`)

  const contractorRateById = {}
  for (const link of links || []) {
    const p = link.profiles
    if (!p) continue
    if (p.employment_type !== 'contractor') continue
    contractorRateById[p.id] = Number(p.hourly_rate) || 0
  }

  // All blocks in the calendar month containing periodStart, with
  // their assignments and roster join. We consider the union of
  // (already-published blocks in the month outside the period)
  // PLUS (all blocks in the period — published or not).
  // ROSTER-FIX.4 — the per-coach overrides ride along: a coach whose window
  // a manager adjusted is paid for THAT window, not the block's.
  const { data: monthBlocks, error: blocksErr } = await db
    .from('shift_blocks')
    .select(`
      id, location_id, block_date, start_time, end_time, roster_id,
      shift_assignments(profile_id, status, start_time_override, end_time_override),
      rosters:roster_id(id, status)
    `)
    .eq('location_id', locationId)
    .gte('block_date', monthStart)
    .lte('block_date', monthEnd)
  if (blocksErr) throw new Error(`Block lookup failed: ${blocksErr.message}`)

  // ROSTER-FIX.4 — approved leave for the month, in ONE query. A coach on
  // approved leave is not working the shift they are still rostered on, so
  // billing it inflated the projection and could refuse a publish that was
  // actually within budget.
  const { data: leave, error: leaveErr } = await db
    .from('time_off_requests')
    .select('profile_id, start_date, end_date')
    .eq('location_id', locationId)
    .eq('status', 'approved')
    .lte('start_date', monthEnd)
    .gte('end_date', monthStart)
  if (leaveErr) throw new Error(`Leave lookup failed: ${leaveErr.message}`)

  const leaveByProfile = new Map()
  for (const row of leave || []) {
    if (!leaveByProfile.has(row.profile_id)) leaveByProfile.set(row.profile_id, [])
    leaveByProfile.get(row.profile_id).push(row)
  }

  return {
    location: loc,
    monthStart,
    monthEnd,
    contractorRateById,
    leaveByProfile,
    monthBlocks: monthBlocks || [],
  }
}

/**
 * Is this coach on approved leave on this date? Both ends inclusive —
 * time_off_requests.end_date is documented inclusive (mig 011). Dates are
 * ISO YYYY-MM-DD strings, so string comparison IS date comparison.
 */
function isOnLeave(leaveByProfile, profileId, dateIso) {
  const rows = leaveByProfile?.get(profileId)
  if (!rows) return false
  return rows.some((r) => r.start_date <= dateIso && r.end_date >= dateIso)
}

function blockContractorCost(block, contractorRateById, leaveByProfile) {
  let cost = 0
  // ROSTER-FIX.1 — a cancelled assignment costs nothing; counting it here
  // pushed publishes over the contractor budget for shifts nobody works.
  for (const a of liveAssignments(block.shift_assignments)) {
    const rate = contractorRateById[a.profile_id] || 0
    if (rate === 0) continue
    // ROSTER-FIX.4 — a coach on approved leave isn't working this shift.
    if (isOnLeave(leaveByProfile, a.profile_id, block.block_date)) continue
    // ROSTER-FIX.4 — hours are PER ASSIGNMENT: shiftHours prefers the
    // coach's override window and falls back to the block's.
    const hours = shiftHours({
      start_time_override: a.start_time_override,
      end_time_override: a.end_time_override,
      shift_templates: { start_time: block.start_time, end_time: block.end_time },
    })
    cost += hours * rate
  }
  return cost
}

/**
 * Project what the month-total contractor cost will be after
 * publishing (period_start, period_end). Does NOT mutate state.
 *
 * @returns {{
 *   monthStart, monthEnd,
 *   monthlyBudgetEur: number | null,
 *   alreadyPublishedEur: number,     // outside the period, on a published roster
 *   periodProjectedEur: number,      // about to be published
 *   monthProjectedTotalEur: number,
 *   remainingEur: number | null,
 *   overBudget: boolean,
 *   overrunEur: number,              // 0 if under, positive if over
 *   blockCount: number,
 * }}
 */
export async function projectPublishImpact(db, { locationId, periodStart, periodEnd }) {
  const ctx = await loadBudgetContext(db, locationId, periodStart)
  const { location, monthStart, monthEnd, contractorRateById, leaveByProfile, monthBlocks } = ctx

  let alreadyPublishedEur = 0
  let periodProjectedEur = 0
  let blockCount = 0

  for (const b of monthBlocks) {
    const cost = blockContractorCost(b, contractorRateById, leaveByProfile)
    if (cost === 0) continue
    const inPeriod = b.block_date >= periodStart && b.block_date <= periodEnd
    if (inPeriod) {
      periodProjectedEur += cost
      blockCount++
    } else {
      // Only count if currently on a PUBLISHED roster — drafts
      // don't consume budget until they're published.
      if (b.rosters?.status === 'published') {
        alreadyPublishedEur += cost
      }
    }
  }

  const budget = location?.monthly_contractor_budget_eur != null
    ? Number(location.monthly_contractor_budget_eur)
    : null

  const monthProjectedTotalEur = round2(alreadyPublishedEur + periodProjectedEur)
  const remainingEur = budget != null ? round2(budget - monthProjectedTotalEur) : null
  const overBudget = budget != null && monthProjectedTotalEur > budget
  const overrunEur = overBudget ? round2(monthProjectedTotalEur - budget) : 0

  return {
    monthStart,
    monthEnd,
    monthlyBudgetEur: budget,
    alreadyPublishedEur: round2(alreadyPublishedEur),
    periodProjectedEur: round2(periodProjectedEur),
    monthProjectedTotalEur,
    remainingEur,
    overBudget,
    overrunEur,
    blockCount,
  }
}

/**
 * ROSTER-FIX.4 — the published rosters at `locationId` that (periodStart,
 * periodEnd) would collide with.
 *
 * WHY: publishing rewrites `shift_blocks.roster_id` for every block in the
 * period, so a second overlapping published roster silently STEALS the days
 * it shares — the older row still claims those dates while owning none of
 * their blocks, and "which roster published this day" (reports,
 * findPublishedRosterFor, the approvals queue) stops having one answer.
 *
 * A published roster is NOT a conflict when the new period fully contains
 * it, which covers both legitimate overlaps:
 *   - the EXACT same period — how a re-publish re-notifies the coaches whose
 *     shifts changed since last time;
 *   - a period that CONTAINS the published one — the documented "publish the
 *     week, then publish the whole month" flow, where the wider roster takes
 *     over every block including the earlier week's.
 * Everything else (a week inside an already-published month, a period that
 * straddles the edge of one) is the same days published twice under two
 * names. See the KNOWN GAP note at the POST call site for what a superset
 * publish leaves behind.
 *
 * Both period bounds are inclusive, and dates are ISO YYYY-MM-DD strings, so
 * string comparison IS date comparison.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {{ locationId: string, periodStart: string, periodEnd: string, excludeRosterId?: string|null }} opts
 * @returns {Promise<{ conflicts: Array<{id: string, period_start: string, period_end: string}>, error: any }>}
 */
export async function findConflictingPublishedRosters(db, { locationId, periodStart, periodEnd, excludeRosterId = null } = {}) {
  let query = db
    .from('rosters')
    .select('id, period_start, period_end')
    .eq('location_id', locationId)
    .eq('status', 'published')
    // Inclusive-range overlap: starts on or before our end AND ends on or
    // after our start.
    .lte('period_start', periodEnd)
    .gte('period_end', periodStart)
  // The approve path re-checks a roster that already exists as a row; it must
  // not count itself as the thing it collides with.
  if (excludeRosterId) query = query.neq('id', excludeRosterId)

  const { data, error } = await query
  if (error) return { conflicts: [], error }

  // Contained-in-the-new-period is inclusive on both ends, so an exact
  // re-publish falls out as "contained" and is allowed too.
  const conflicts = (data || []).filter((r) => !(r.period_start >= periodStart && r.period_end <= periodEnd))
  return { conflicts, error: null }
}

function round2(n) { return Math.round(n * 100) / 100 }
