// RUNWAY.1 — the server read behind the roster-runway chip and push.
//
// Named -data, not roster-runway.js: a src/lib module with the same filename
// as a shared/ one is a "pair" that tests/shared-pair-sync.test.js makes you
// classify. The rule itself lives in shared/roster-runway.js; this is the IO.
//
// Why this does not call fetchStaffingGapsThisWeek (src/lib/roster-staffing.js):
// that reader is hard-wired to "today .. this Sunday" and returns three totals
// across all locations. The runway needs three weeks, per location, plus each
// block's roster status. What IS reused is the part that matters, the staffing
// answer (futureBlockStaffing, via runwayWeeksFromBlocks) and the same select
// shape, so "staffed" means the same thing on every surface.

import { selectAll } from './select-all'
import { dublinTodayStr } from './dublin-time'
import { runwayWindow, runwayWeeksFromBlocks, rosterRunway } from '@shared/roster-runway'

/**
 * Roster runway per location.
 *
 * A location with no ACTIVE shift template that has at least one weekday is
 * skipped outright (Hatch Street today, and every non-gym location): it has
 * nothing to roster, and leftover blocks from a retired template must not
 * raise an alert nobody can clear.
 *
 * @param {object} db  service-role supabase client
 * @param {string[]} locationIds
 * @param {{ todayIso?: string }} [opts]  the Dublin business day
 * @returns {Promise<{ success: true, data: { byLocation: Record<string, object|null> } } | { success: false, error: string }>}
 */
export async function fetchRosterRunways(db, locationIds, { todayIso = dublinTodayStr() } = {}) {
  const ids = [...new Set((locationIds || []).filter(Boolean))]
  const byLocation = Object.fromEntries(ids.map((id) => [id, null]))
  if (ids.length === 0) return { success: true, data: { byLocation } }

  const { data: templates, error: tplErr } = await db
    .from('shift_templates')
    .select('location_id, days_of_week')
    .eq('active', true)
    .in('location_id', ids)
  if (tplErr) return { success: false, error: tplErr.message }

  const rostered = [...new Set(
    (templates || [])
      .filter((t) => Array.isArray(t.days_of_week) && t.days_of_week.length > 0)
      .map((t) => t.location_id),
  )]
  if (rostered.length === 0) return { success: true, data: { byLocation } }

  const { from, to } = runwayWindow(todayIso)
  let blocks
  try {
    // Paged: three weeks x ~50 blocks x several studios can pass the 1,000-row
    // select cap, and a truncated read would silently call a week "ready".
    blocks = await selectAll((lo, hi) => db
      .from('shift_blocks')
      .select('id, location_id, block_date, min_coaches, rosters:roster_id ( status ), shift_assignments(profile_id, status)')
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
    byLocation[id] = rosterRunway(runwayWeeksFromBlocks(mine, todayIso), todayIso)
  }
  return { success: true, data: { byLocation } }
}
