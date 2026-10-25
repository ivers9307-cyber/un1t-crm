// ROSTERVIS.1 — roster visibility: is a shift staffed, and is a period
// published?
//
// Two review findings, one module:
//
//   1. The calendar, the week banner, the Today chip and the publish preview
//      all noticed a shift only at ZERO coaches. A shift budgeted for two that
//      has one read as fine everywhere except the Studio Overview strip, which
//      has counted below-minimum blocks since SHIFTMIN.1. Live on 2026-09-17:
//      five published shifts at 1 of 2 coaches, invisible on the calendar.
//      `staffingStatus` is the one answer now, shared by every surface.
//
//   2. The manager calendar never said whether the week on screen was
//      published. Its only signal was an in-memory unsaved-changes flag that a
//      reload drops. `periodPublicationStatus` derives it from what the blocks
//      feed already carries (each block's embedded `rosters.status`) plus the
//      draft rosters, which a block cannot carry: a draft roster awaiting
//      approval does NOT tag blocks (only a publish/approve re-tags them), so a
//      draft is invisible from the blocks alone.
//
// Pure on its inputs apart from `fetchStaffingGapsThisWeek`, which takes the
// supabase client the way src/lib/roster.js does.

import { addDays, formatDate, getMonday } from './roster'
import { getLocationZones, todayStrIn } from './location-time'
import { countStaffingGaps } from '../../shared/roster-staffing'

// MOBILESCHED.2 — the pure half (staffing status, gaps, publication status)
// lives in shared/roster-staffing.js so the mobile Manage mode answers from the
// same functions. EVERY export of that module must be listed here: web callers
// import from '@/lib/roster-staffing', so a name missing from this list
// resolves to `undefined` with no build error, and
// tests/shared-pair-sync.test.js holds the pair in mode `reexport` (runtime
// identity). fetchStaffingGapsThisWeek below is the one web-only (IO) export.
export {
  staffingStatus,
  futureBlockStaffing,
  staffingGaps,
  countStaffingGaps,
  staffingGapsHeadline,
  staffingGapsBreakdown,
  PUBLICATION_LABELS,
  periodPublicationStatus,
} from '../../shared/roster-staffing'

/**
 * The Today chip's server read: future blocks from today to the end of this
 * week (Mon-Sun) across the caller's locations, counted by staffing gap.
 *
 * It replaced the old zero-only count in shared/dashboard-data (ROSTERVIS.1),
 * which D1 DEADCODE.1 deleted once nothing read it.
 *
 * "Today" is EACH studio's own day (TZ.8a: its locations.timezone, read once
 * with getLocationZones unless the caller passes `zones`, id → zone), never
 * the server's UTC day; "this week" is that studio's Mon-Sun around it. An
 * unreadable zone fails the read, never a guess. `todayIso` pins one day for
 * every studio (tests).
 *
 * @param {{ todayIso?: string, zones?: Map<string,string>|Record<string,string>, nowMs?: number }} [opts]
 * @returns {Promise<{ success: true, data: { empty: number, short: number, total: number } } | { success: false, error: string }>}
 */
export async function fetchStaffingGapsThisWeek(db, locationIds, { todayIso = null, zones = null, nowMs = Date.now() } = {}) {
  if (!locationIds || locationIds.length === 0) {
    return { success: true, data: { empty: 0, short: 0, total: 0 } }
  }
  const ids = [...new Set(locationIds.filter(Boolean))]
  let zoneOf = null
  if (!todayIso) {
    try {
      const given = zones instanceof Map ? zones : (zones ? new Map(Object.entries(zones)) : null)
      zoneOf = given && ids.every((id) => given.has(id)) ? given : await getLocationZones(db, ids, { nowMs })
    } catch (e) {
      return { success: false, error: e?.message || 'Failed to read studio timezones' }
    }
  }
  const weekEndOf = (iso) => {
    const [y, m, d] = iso.split('-').map(Number)
    return formatDate(addDays(getMonday(new Date(y, m - 1, d)), 6))
  }
  const windows = new Map(ids.map((id) => {
    const today = todayIso || todayStrIn(zoneOf.get(id), nowMs)
    return [id, { today, weekEnd: weekEndOf(today) }]
  }))
  const readFrom = [...windows.values()].map((w) => w.today).sort()[0]
  const weekEndIso = [...windows.values()].map((w) => w.weekEnd).sort().at(-1)

  // The assignment ROWS, not a `(count)` embed: an aggregate embed cannot be
  // status-filtered, and a cancelled row must not count as a coach
  // (ROSTER-FIX.1). One week across a handful of locations is well under the
  // 1,000-row select cap.
  const { data, error } = await db
    .from('shift_blocks')
    // SHIFTTYPE.1 — the template's kind rides along: an admin block is never a gap.
    .select('id, location_id, block_date, start_time, min_coaches, shift_templates(kind), shift_assignments(profile_id, status)')
    .in('location_id', locationIds)
    .gte('block_date', readFrom)
    .lte('block_date', weekEndIso)

  if (error) return { success: false, error: error.message }
  // One pinned day: every row read is in that one window.
  if (todayIso) return { success: true, data: countStaffingGaps(data || [], { todayIso }) }
  // Each studio's blocks are counted on its own today and week.
  const total = { empty: 0, short: 0, total: 0 }
  for (const [id, w] of windows) {
    const mine = (data || []).filter((b) => b.location_id === id)
    const c = countStaffingGaps(mine, { from: w.today, to: w.weekEnd, todayIso: w.today })
    total.empty += c.empty
    total.short += c.short
    total.total += c.total
  }
  return { success: true, data: total }
}
