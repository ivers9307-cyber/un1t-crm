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
import { dublinTodayStr } from './dublin-time'
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
 * Replaces the web page's use of shared/dashboard-data's
 * fetchUnstaffedBlocksThisWeek (zero-only). That helper is left in shared/
 * untouched, because any change under shared/ publishes an OTA.
 *
 * "Today" is the Dublin business day, not the server's UTC day.
 *
 * @returns {Promise<{ success: true, data: { empty: number, short: number, total: number } } | { success: false, error: string }>}
 */
export async function fetchStaffingGapsThisWeek(db, locationIds, { todayIso = dublinTodayStr() } = {}) {
  if (!locationIds || locationIds.length === 0) {
    return { success: true, data: { empty: 0, short: 0, total: 0 } }
  }
  const [y, m, d] = todayIso.split('-').map(Number)
  const weekEndIso = formatDate(addDays(getMonday(new Date(y, m - 1, d)), 6))

  // The assignment ROWS, not a `(count)` embed: an aggregate embed cannot be
  // status-filtered, and a cancelled row must not count as a coach
  // (ROSTER-FIX.1). One week across a handful of locations is well under the
  // 1,000-row select cap.
  const { data, error } = await db
    .from('shift_blocks')
    .select('id, location_id, block_date, start_time, min_coaches, shift_assignments(profile_id, status)')
    .in('location_id', locationIds)
    .gte('block_date', todayIso)
    .lte('block_date', weekEndIso)

  if (error) return { success: false, error: error.message }
  return { success: true, data: countStaffingGaps(data || [], { todayIso }) }
}
