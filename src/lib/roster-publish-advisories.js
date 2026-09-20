// COPYLEAVE.1 — what the publish preview warns about besides staffing gaps:
//
//   leaveClashes    a coach rostered on a day they have APPROVED leave.
//   doubleBookings  one coach on two live shifts whose hours overlap, where at
//                   least one of the two is at the studio being published. The
//                   other may be at ANOTHER studio: a coach cannot be in two
//                   places, and nothing else on the web screen can see that.
//
// ADVISORY ONLY, the same posture as the staffing-gap list (ROSTERVIS.1) and
// the assign picker's clash badge (schedule-overlap.js): a coach legitimately
// floats between adjacent slots and the manager is the judge. Nothing here may
// block a publish. Names and times only: no rate, cost or contract hours.
//
// Pure. Future blocks only (block_date >= todayIso), the rule staffingGaps uses.

import { isLiveAssignment } from './roster'
import { timeRangesOverlap, fmtTime } from './schedule-overlap'

/**
 * The approved-leave row covering this coach on this date, or null.
 * `leaveByProfile` is loadBudgetContext's Map<profile_id, rows>, which only
 * ever holds APPROVED rows. Both ends inclusive (mig 011).
 */
export function leaveCovering(leaveByProfile, profileId, dateIso) {
  const rows = leaveByProfile?.get(profileId)
  if (!rows) return null
  return rows.find((r) => r.start_date <= dateIso && r.end_date >= dateIso) || null
}

function inScope(dateIso, { from, to, todayIso }) {
  if (!dateIso) return false
  if (from && dateIso < from) return false
  if (to && dateIso > to) return false
  if (todayIso && dateIso < todayIso) return false
  return true
}

const byDateThenStart = (a, b) =>
  String(a.block_date).localeCompare(String(b.block_date))
  || String(a.start_time || '').localeCompare(String(b.start_time || ''))

/**
 * @returns {Array<{ block_id, block_date, start_time, end_time, name,
 *   profile_id, coach_name, leave_start, leave_end }>}
 */
export function leaveClashes(blocks, { from = null, to = null, todayIso = null, leaveByProfile } = {}) {
  const out = []
  for (const b of blocks || []) {
    if (!inScope(b?.block_date, { from, to, todayIso })) continue
    for (const a of (b.shift_assignments || []).filter(isLiveAssignment)) {
      const leave = leaveCovering(leaveByProfile, a.profile_id, b.block_date)
      if (!leave) continue
      out.push({
        block_id: b.id,
        block_date: b.block_date,
        // The hours the coach is down for: their override, else the block's.
        start_time: a.start_time_override || b.start_time,
        end_time: a.end_time_override || b.end_time,
        name: b.shift_templates?.name || 'Shift',
        profile_id: a.profile_id,
        coach_name: a.profiles?.full_name || 'Coach',
        leave_start: leave.start_date,
        leave_end: leave.end_date,
      })
    }
  }
  return out.sort(byDateThenStart)
}

/**
 * @param {Array<object>} blocks  this studio's blocks (loadBudgetContext shape)
 * @param {Array<object>|null} otherAssignments  the same coaches' assignments
 *   at OTHER studios: { profile_id, status, start_time_override,
 *   end_time_override, shift_blocks: { id, block_date, start_time, end_time,
 *   shift_templates: { name }, locations: { name } } }. null = could not be read.
 * @returns {Array<{ profile_id, coach_name, block_date,
 *   first:  { block_id, name, start_time, end_time, location_name },
 *   second: { block_id, name, start_time, end_time, location_name } }>}
 *   `location_name` is null for a shift at the studio being published.
 */
export function doubleBookings(blocks, otherAssignments, { from = null, to = null, todayIso = null } = {}) {
  // coach|date -> every live window that coach has that day, here or elsewhere.
  const windows = new Map()
  const names = new Map()
  const add = (profileId, date, w) => {
    const key = `${profileId}|${date}`
    if (!windows.has(key)) windows.set(key, [])
    windows.get(key).push(w)
  }

  for (const b of blocks || []) {
    if (!inScope(b?.block_date, { from, to, todayIso })) continue
    for (const a of (b.shift_assignments || []).filter(isLiveAssignment)) {
      if (a.profiles?.full_name) names.set(a.profile_id, a.profiles.full_name)
      add(a.profile_id, b.block_date, {
        here: true,
        block_id: b.id,
        name: b.shift_templates?.name || 'Shift',
        start_time: fmtTime(a.start_time_override || b.start_time),
        end_time: fmtTime(a.end_time_override || b.end_time),
        location_name: null,
      })
    }
  }

  for (const a of (otherAssignments || []).filter(isLiveAssignment)) {
    const ob = a.shift_blocks
    if (!ob || !inScope(ob.block_date, { from, to, todayIso })) continue
    add(a.profile_id, ob.block_date, {
      here: false,
      block_id: ob.id,
      name: ob.shift_templates?.name || 'Shift',
      start_time: fmtTime(a.start_time_override || ob.start_time),
      end_time: fmtTime(a.end_time_override || ob.end_time),
      location_name: ob.locations?.name || 'Another studio',
    })
  }

  const out = []
  for (const [key, list] of windows) {
    const [profileId, date] = key.split('|')
    const sorted = [...list].sort((x, y) => x.start_time.localeCompare(y.start_time))
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const first = sorted[i]
        const second = sorted[j]
        if (!first.here && !second.here) continue
        if (!timeRangesOverlap(first.start_time, first.end_time, second.start_time, second.end_time)) continue
        const strip = ({ here: _here, ...rest }) => rest
        out.push({
          profile_id: profileId,
          coach_name: names.get(profileId) || 'Coach',
          block_date: date,
          first: strip(first),
          second: strip(second),
        })
      }
    }
  }
  return out.sort((a, b) =>
    a.block_date.localeCompare(b.block_date)
    || a.first.start_time.localeCompare(b.first.start_time)
    || a.coach_name.localeCompare(b.coach_name))
}
