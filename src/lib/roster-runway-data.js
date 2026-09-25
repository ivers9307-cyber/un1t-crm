// RUNWAY.1 — the server read behind the roster-runway chip and push.
//
// Named -data, not roster-runway.js: a src/lib module with the same filename
// as a shared/ one is a "pair" that tests/shared-pair-sync.test.js makes you
// classify. The rule itself lives in shared/roster-runway.js; this is the IO.
//
// Why this does not call fetchStaffingGapsThisWeek (src/lib/roster-staffing.js):
// that reader is hard-wired to "today .. this Sunday" and returns three totals
// across all locations. The two are COMPLEMENTS: it owns the current week (as
// does the schedule banner, for publication), and the runway owns the two
// weeks that start after it, per location, with each block's roster status.
// The current week's blocks are not read here at all. What IS reused is the
// part that matters, the staffing answer (futureBlockStaffing, via
// runwayWeeksFromBlocks) and the same select shape, so "staffed" means the
// same thing on every surface.

import { selectAll } from './select-all'
import { dublinTodayStr } from './dublin-time'
import { runwayWindow, runwayWeeksFromBlocks, rosterRunwayWeeks } from '@shared/roster-runway'
import { isAdminShift } from '@shared/shift-kind'

/**
 * Roster runway per location.
 *
 * A location with no ACTIVE shift template that has at least one weekday is
 * skipped outright (Hatch Street today, and every non-gym location): it has
 * nothing to roster, and leftover blocks from a retired template must not
 * raise an alert nobody can clear. A location whose only active templates are
 * admin is skipped the same way (SHIFTTYPE.1).
 *
 * @param {object} db  service-role supabase client
 * @param {string[]} locationIds
 * @param {{ todayIso?: string }} [opts]  the Dublin business day
 * `byLocation[id]` is the FIRST unready week (or null): what a chip shows.
 * `weeksByLocation[id]` is EVERY unready week inside the horizon (or []): what
 * the daily push walks, so one unfillable shift next week cannot hide the week
 * after until it is 7 days out. Only weeks that start AFTER today appear.
 *
 * @returns {Promise<{ success: true, data: { byLocation: Record<string, object|null>, weeksByLocation: Record<string, object[]> } } | { success: false, error: string }>}
 */
export async function fetchRosterRunways(db, locationIds, { todayIso = dublinTodayStr() } = {}) {
  const ids = [...new Set((locationIds || []).filter(Boolean))]
  const byLocation = Object.fromEntries(ids.map((id) => [id, null]))
  const weeksByLocation = Object.fromEntries(ids.map((id) => [id, []]))
  if (ids.length === 0) return { success: true, data: { byLocation, weeksByLocation } }

  // Paged and ordered like the blocks read below: .select() is capped at 1,000
  // rows, and a studio whose active templates fell past the cap would silently
  // read as "nothing to roster", i.e. ready.
  let templates
  try {
    templates = await selectAll((lo, hi) => db
      .from('shift_templates')
      .select('id, location_id, days_of_week, kind')
      .eq('active', true)
      .in('location_id', ids)
      .order('id', { ascending: true })
      .range(lo, hi))
  } catch (e) {
    return { success: false, error: e?.message || 'Failed to read shift templates' }
  }

  // SHIFTTYPE.1 — only a CLASS template puts a studio on the runway. A studio
  // whose only active templates are admin has no shift that needs a coach
  // (admin carries no minimum staffing), so it has nothing to roster.
  const rostered = [...new Set(
    (templates || [])
      .filter((t) => Array.isArray(t.days_of_week) && t.days_of_week.length > 0 && !isAdminShift(t))
      .map((t) => t.location_id),
  )]
  if (rostered.length === 0) return { success: true, data: { byLocation, weeksByLocation } }

  const { from, to } = runwayWindow(todayIso)
  let blocks
  try {
    // Paged: two weeks x ~50 blocks x many studios can pass the 1,000-row
    // select cap, and a truncated read would silently call a week "ready".
    blocks = await selectAll((lo, hi) => db
      .from('shift_blocks')
      .select('id, location_id, block_date, min_coaches, shift_templates ( kind ), rosters:roster_id ( status ), shift_assignments(profile_id, status)')
      .in('location_id', rostered)
      .gte('block_date', from)
      .lte('block_date', to)
      .order('id', { ascending: true })
      .range(lo, hi))
  } catch (e) {
    return { success: false, error: e?.message || 'Failed to read shift blocks' }
  }

  for (const id of rostered) {
    const mine = blocks.filter((b) => b.location_id === id)
    weeksByLocation[id] = rosterRunwayWeeks(runwayWeeksFromBlocks(mine, todayIso), todayIso)
    byLocation[id] = weeksByLocation[id][0] ?? null
  }
  return { success: true, data: { byLocation, weeksByLocation } }
}
