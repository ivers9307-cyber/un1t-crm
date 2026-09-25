// WORKTIME.1 — the shifts working-time advisories are judged on: every live
// assignment of these people, EMPLOYEES ONLY, at every studio of the
// organisation `locationId` belongs to, on block dates [from, to].
//
// ORGSCOPE.1: "both studios" means this studio plus its organisation's other
// studios (siblingLocationIds), never a studio of another organisation.
// Nothing keeps a person inside one organisation, and the advisory prints the
// other shift's times and studio. The embedded filter is the boundary; the rows
// are re-checked against it afterwards, like the assign route's double-booking
// read.
//
// Pay never enters. profiles is read for id, full_name and employment_type
// only (it still carries pay columns: CLAUDE.md, "name your columns"), and
// profile_compensation is not read at all. A contractor's shifts are never
// read: the assignments query takes the covered people's ids only.
//
// Cost: four fixed reads whatever the number of blocks (two small locations
// reads in siblingLocationIds, one profiles read, the assignments paged at
// 1,000). A fifth (approved leave) only if SUBTRACT_APPROVED_LEAVE is flipped.
// The assignments read is readOrgShiftRows, shared with CANDIDATES.1.
//
// Never throws. Unreadable siblings narrow the read to this studio and set
// crossStudioChecked false. A failed profiles, assignments or leave read
// returns `error` with NO shifts, which callers report as "could not be
// checked", never as an all-clear.

import { isLiveAssignment } from './roster'
import { siblingLocationIds } from './sibling-locations'
import { logWarn } from './log'
import { isWorkingTimeCovered } from '@shared/working-time'

// OWNER REVIEW (WORKTIME.1 review note 3): a live assignment on an
// UNPUBLISHED block at the organisation's OTHER studio counts. A half-built
// draft week there can flag here; the alternative hides a real clash until
// that studio publishes. Same set doubleBookings reads. This studio's own
// drafts always count: they are the roster being built. One-line switch.
export const COUNT_UNPUBLISHED_ELSEWHERE = true

// OWNER REVIEW (WORKTIME.1 review note 4): approved leave is NOT subtracted.
// A coach rostered on a day off still counts those hours; the same preview
// already lists that shift under "rostered on approved leave". Flipping this
// adds one read of approved time_off_requests (leave covers the PERSON,
// LEAVE.2, so it is not studio-filtered) and drops the shifts it covers.
export const SUBTRACT_APPROVED_LEAVE = false

const PAGE = 1000

// Approved leave overlapping [from, to] for these people, paged. Map of
// profile_id → [{ start_date, end_date }] (both inclusive, mig 011).
async function readApprovedLeave(db, profileIds, from, to) {
  const byProfile = new Map()
  for (let offset = 0; ; offset += PAGE) {
    const { data: page, error } = await db
      .from('time_off_requests')
      .select('id, profile_id, start_date, end_date')
      .in('profile_id', profileIds)
      .eq('status', 'approved')
      .lte('start_date', to)
      .gte('end_date', from)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) return { byProfile: null, error }
    for (const l of page || []) {
      if (!byProfile.has(l.profile_id)) byProfile.set(l.profile_id, [])
      byProfile.get(l.profile_id).push(l)
    }
    if (!page || page.length < PAGE) break
  }
  return { byProfile, error: null }
}

/**
 * Every LIVE assignment of `profileIds` on block dates [from, to] at the
 * studios in `scopeIds` (this studio first), flattened to the shape the
 * shared rules read. WORKTIME.1's loop, extracted for CANDIDATES.1, which
 * needs everyone's shifts (a contractor can be busy), not employees only.
 *
 * The embedded `.in('shift_blocks.location_id', …)` is the boundary; every row
 * is re-checked against it afterwards. `countUnpublishedElsewhere` false drops
 * rows on an unpublished roster at a studio other than `locationId`.
 * `skip(profileId, blockDate)` true drops a row (approved leave, for WORKTIME's
 * switch). Paged at 1,000, ordered by id. Never throws: a failed read returns
 * `error` with NO shifts.
 *
 * @returns {Promise<{ shifts: object[], error: { message: string } | null }>}
 */
export async function readOrgShiftRows(db, {
  locationId, scopeIds, profileIds, from, to,
  countUnpublishedElsewhere = COUNT_UNPUBLISHED_ELSEWHERE,
  skip = null,
} = {}) {
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  const scope = [...new Set([locationId, ...(scopeIds || [])].filter(Boolean))]
  if (ids.length === 0 || scope.length === 0) return { shifts: [], error: null }
  try {
    const shifts = []
    for (let offset = 0; ; offset += PAGE) {
      const { data: page, error } = await db
        .from('shift_assignments')
        // One literal string, so check:select-columns can resolve every column.
        .select('id, profile_id, status, start_time_override, end_time_override, shift_blocks!inner(id, location_id, block_date, start_time, end_time, roster_id, shift_templates(name, start_time, end_time), locations(name), rosters:roster_id(status))')
        .in('profile_id', ids)
        .in('shift_blocks.location_id', scope)
        .gte('shift_blocks.block_date', from)
        .lte('shift_blocks.block_date', to)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) return { shifts: [], error }
      for (const a of page || []) {
        const b = a?.shift_blocks
        // The filter above is the boundary; this re-check does not depend on
        // how PostgREST applies an embedded filter.
        if (!b || !scope.includes(b.location_id) || !isLiveAssignment(a)) continue
        if (!countUnpublishedElsewhere && b.location_id !== locationId && b.rosters?.status !== 'published') continue
        if (skip && skip(a.profile_id, b.block_date)) continue
        shifts.push({
          profile_id: a.profile_id,
          block_id: b.id,
          block_date: b.block_date,
          location_id: b.location_id,
          location_name: b.locations?.name ?? null,
          name: b.shift_templates?.name || 'Shift',
          status: a.status ?? null,
          start_time_override: a.start_time_override ?? null,
          end_time_override: a.end_time_override ?? null,
          start_time: b.start_time ?? null,
          end_time: b.end_time ?? null,
          shift_templates: { start_time: b.shift_templates?.start_time ?? null, end_time: b.shift_templates?.end_time ?? null },
        })
      }
      if (!page || page.length < PAGE) break
    }
    return { shifts, error: null }
  } catch (e) {
    return { shifts: [], error: { message: e?.message || 'shift read threw' } }
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {{ locationId: string, profileIds: string[], from: string, to: string,
 *   countUnpublishedElsewhere?: boolean, subtractApprovedLeave?: boolean }} opts
 * @returns {Promise<{
 *   shifts: Array<{ profile_id, block_id, block_date, location_id, location_name, name, status,
 *     start_time_override, end_time_override, start_time, end_time, shift_templates }>,
 *   people: Map<string, { full_name: string|null, employment_type: string|null }>,
 *   crossStudioChecked: boolean,
 *   error: { message: string } | null,
 * }>}
 */
export async function loadWorkingTimeShifts(db, {
  locationId, profileIds, from, to,
  countUnpublishedElsewhere = COUNT_UNPUBLISHED_ELSEWHERE,
  subtractApprovedLeave = SUBTRACT_APPROVED_LEAVE,
} = {}) {
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  if (!locationId || ids.length === 0) {
    return { shifts: [], people: new Map(), crossStudioChecked: true, error: null }
  }
  const failed = (error) => ({ shifts: [], people: new Map(), crossStudioChecked: false, error })

  try {
    const { ids: siblingIds, error: sibErr } = await siblingLocationIds(db, locationId)
    if (sibErr) {
      logWarn('working-time', 'sibling studios unreadable; working-time check is this studio only', { locationId, err: sibErr.message })
    }
    const crossStudioChecked = !sibErr
    const scopeIds = [locationId, ...(siblingIds || []).filter((id) => id && id !== locationId)]

    const { data: rows, error: peopleErr } = await db
      .from('profiles')
      .select('id, full_name, employment_type')
      .in('id', ids)
    if (peopleErr) return failed(peopleErr)
    const people = new Map()
    for (const p of rows || []) {
      if (p?.id) people.set(p.id, { full_name: p.full_name ?? null, employment_type: p.employment_type ?? null })
    }
    const coveredIds = ids.filter((id) => isWorkingTimeCovered(people.get(id)?.employment_type))
    if (coveredIds.length === 0) return { shifts: [], people, crossStudioChecked, error: null }

    let leaveByProfile = null
    if (subtractApprovedLeave) {
      const leave = await readApprovedLeave(db, coveredIds, from, to)
      if (leave.error) return failed(leave.error)
      leaveByProfile = leave.byProfile
    }
    const onLeave = (profileId, date) => Boolean(leaveByProfile?.get(profileId)
      ?.some((l) => l.start_date <= date && l.end_date >= date))

    const read = await readOrgShiftRows(db, {
      locationId, scopeIds, profileIds: coveredIds, from, to, countUnpublishedElsewhere, skip: onLeave,
    })
    if (read.error) return failed(read.error)
    return { shifts: read.shifts, people, crossStudioChecked, error: null }
  } catch (e) {
    return failed({ message: e?.message || 'working-time read threw' })
  }
}
