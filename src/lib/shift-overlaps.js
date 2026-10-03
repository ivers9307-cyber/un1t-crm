// SCHEDULE-DOUBLE-BOOKING.1 / BLOCKEDIT.1 review 4 — "a coach cannot be in two
// places at once", as ONE advisory shared by the assign route
// (POST /api/schedule/blocks/[id]/assignments) and the shift editor
// (PUT /api/schedule/blocks/[id]).
//
// Advisory only: it WARNS, never blocks, and never throws. A failure to check
// must never cost the write that already happened.
//
// ORGSCOPE.1 — the warning prints the other shift's name, times and studio, so
// "another studio" means another studio of THIS organisation
// (siblingLocationIds). Unreadable siblings narrow the check to this studio;
// they never widen it.

import { siblingLocationIds } from './sibling-locations'
import { timeRangesOverlap, fmtTime } from './schedule-overlap'
import { logWarn } from './log'

/**
 * @param {object} db  service-role client
 * @param {object} args
 * @param {string} args.locationId  the studio of the shift being written
 * @param {string} args.blockId     that shift (excluded from the search)
 * @param {string} args.blockDate   YYYY-MM-DD
 * @param {Array<{ profileId: string, start_time: string, end_time: string }>} args.windows
 *        each coach's OWN window on the shift being written
 * @param {string} [args.logTag]
 * @returns {Promise<{ clashes: Array<{ profileId: string, name: string, text: string }> }>}
 */
export async function findShiftOverlaps(db, { locationId, blockId, blockDate, windows = [], logTag = 'shift-overlaps' } = {}) {
  const clashes = []
  const byProfile = new Map()
  for (const w of windows || []) {
    if (w?.profileId && w.start_time && w.end_time) byProfile.set(w.profileId, w)
  }
  if (byProfile.size === 0 || !locationId || !blockDate) return { clashes }
  try {
    const { ids: siblingIds, error: sibErr } = await siblingLocationIds(db, locationId)
    if (sibErr) {
      logWarn(logTag, 'sibling studios unreadable; double-booking check is this studio only', { locationId, err: sibErr.message })
    }
    const scopeIds = [locationId, ...siblingIds]
    const { data, error } = await db
      .from('shift_assignments')
      .select('profile_id, status, shift_blocks!inner(location_id, start_time, end_time, block_date, shift_templates(name), locations(name)), profiles:profile_id(full_name)')
      .in('profile_id', [...byProfile.keys()])
      .in('shift_blocks.location_id', scopeIds)
      .eq('shift_blocks.block_date', blockDate)
      .neq('block_id', blockId)
    if (error) {
      logWarn(logTag, 'double-booking check unreadable; no overlap warnings', { blockId, err: error.message })
      return { clashes }
    }
    for (const c of data || []) {
      if (c.status === 'cancelled') continue
      const ob = c.shift_blocks
      const w = byProfile.get(c.profile_id)
      // The filter above is the boundary; this re-check costs nothing and
      // does not depend on how an embedded filter is applied.
      if (!w || !ob || !scopeIds.includes(ob.location_id)) continue
      if (!timeRangesOverlap(w.start_time, w.end_time, ob.start_time, ob.end_time)) continue
      const name = c.profiles?.full_name || 'This coach'
      const tpl = ob.shift_templates?.name || 'another shift'
      const loc = ob.locations?.name ? ` at ${ob.locations.name}` : ''
      clashes.push({
        profileId: c.profile_id,
        name,
        text: `${name} is already on ${tpl} ${fmtTime(ob.start_time)}–${fmtTime(ob.end_time)}${loc} that day — overlaps this shift.`,
      })
    }
  } catch (e) {
    logWarn(logTag, 'double-booking check threw; no overlap warnings', { blockId, err: e?.message })
  }
  return { clashes }
}
