// src/lib/candidates-data.js
//
// CANDIDATES.1 — the reads behind GET /api/schedule/blocks/[id]/candidates.
// Service-role client passed in: the ROUTE is the access boundary (CLAUDE.md,
// "Service-role routes get NO RLS"). It has already checked the caller
// belongs to the block's studio and decided the audience.
//
// Who is a candidate: an ACTIVE member of the block's studio (active IS NOT
// FALSE, mig 626; never a tombstone, mig 622) who is not live on the block.
// Same rule as the assign route (isRosterableProfile + membership), so the
// list never offers someone the POST would refuse.
//
// Reads (manager): members (paged) → sibling studios → in parallel: the
// block's Mon–Sun week of shifts, one day either side, at every studio of
// the organisation (readOrgShiftRows, WORKTIME.1's reader); approved leave on
// the day; availability rules (AVAIL.1a readStudioAvailability); contracted
// hours of the EMPLOYEES, only when `withContract` (an owner, a manager or a
// master; never a head coach). Colleague: members, siblings, PUBLISHED
// shifts. Nothing else.
//
// Pay never enters: profiles is read for id, full_name, active, deleted_at,
// employment_type; profile_compensation for profile_id and
// contracted_hours_per_week BY NAME (the table's other four columns are pay).
//
// Never throws. A failed member read is { error } (nothing to rank). Any
// other read that fails OR THROWS (settle) sets its `checked` flag false and
// leaves that fact null, so the picker can say what it did not check.

import { siblingLocationIds } from './sibling-locations'
import { readOrgShiftRows } from './working-time-data'
import { readStudioAvailability } from './availability-server'
import { isRosterableProfile } from './roster-write'
import { liveAssignments } from './roster'
import { mondayOf } from './payroll'
import { addDaysISO } from './dublin-time'
import { logWarn } from './log'
import { buildCandidates } from '@shared/candidates'
import { attachQualificationGaps } from '@shared/qualifications'
import { readBlockQualificationFacts } from './qualifications-server'
import { isWorkingTimeCovered } from '@shared/working-time'

const PAGE = 1000
const CHUNK = 200

// The contracted-hours key removed, for a caller who may not see it.
const withoutContract = (list) => (list || []).map(({ contracted_hours: _omit, ...rest }) => rest)

// CANDIDATES.1 review 3 — a side read that THROWS (a client bug, a network
// fault) is the same as one that returns an error: its facet is "not
// checked", never a 500 for the whole list and never an all-clear.
async function settle(read) {
  try {
    return (await read()) || { error: { message: 'no answer' } }
  } catch (e) {
    return { error: { message: e?.message || 'read threw' } }
  }
}

/**
 * Rosterable members of one studio, minus `excludeIds`, in profile_id order.
 * @returns {Promise<{ members: Array<{ profile_id, full_name, role, employment_type }>|null, error }>}
 */
export async function readEligibleMembers(db, { locationId, excludeIds = [] } = {}) {
  const skip = new Set(excludeIds || [])
  const members = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('profile_locations')
      .select('profile_id, role, profiles!inner(id, full_name, active, deleted_at, employment_type)')
      .eq('location_id', locationId)
      .order('profile_id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) return { members: null, error }
    for (const l of data || []) {
      if (!l?.profile_id || skip.has(l.profile_id) || !isRosterableProfile(l.profiles)) continue
      members.push({
        profile_id: l.profile_id,
        full_name: l.profiles.full_name ?? null,
        role: l.role ?? null,
        employment_type: l.profiles.employment_type ?? null,
      })
    }
    if (!data || data.length < PAGE) break
  }
  return { members, error: null }
}

/** Approved leave covering `dateIso` for these people (both ends inclusive, mig 011). */
export async function readApprovedLeaveOn(db, profileIds, dateIso) {
  const leave = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('time_off_requests')
      .select('id, profile_id, type, start_date, end_date')
      .in('profile_id', profileIds)
      .eq('status', 'approved')
      .lte('start_date', dateIso)
      .gte('end_date', dateIso)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) return { leave: null, error }
    leave.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { leave, error: null }
}

/**
 * profile_id → contracted hours per week (> 0 only), from profile_compensation
 * (mig 152; profiles.contracted_hours_per_week is DEPRECATED). ONE column by
 * name: never getCompensationForProfiles, which reads all five pay columns
 * (it throws on a failed read since LABOUR.1; it used to discard the error).
 * Chunked at 200 like that helper, for .in() URL length.
 */
export async function readContractedHours(db, profileIds) {
  const byProfile = new Map()
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await db
      .from('profile_compensation')
      .select('profile_id, contracted_hours_per_week')
      .in('profile_id', ids.slice(i, i + CHUNK))
    if (error) return { byProfile: null, error }
    for (const row of data || []) {
      const hours = Number(row?.contracted_hours_per_week)
      if (row?.profile_id && Number.isFinite(hours) && hours > 0) byProfile.set(row.profile_id, hours)
    }
  }
  return { byProfile, error: null }
}

/**
 * `publishedShiftsOnly` (REPLACE.1b review 4, owner decision): the manager
 * answer — leave, availability, every studio — but "free" judged on PUBLISHED
 * shifts only, as the colleague audience already is. "Offer to team" asks it
 * this way for its push audience, its coach list and a claim: a coach is never
 * skipped or refused over a draft shift they cannot see. The pickers keep
 * the default (a manager plans drafts, so drafts count there).
 *
 * @param {{ block: { id, location_id, block_date, start_time, end_time, shift_templates, shift_assignments },
 *   audience: 'manager'|'colleague', withContract?: boolean, publishedShiftsOnly?: boolean }} opts
 * @returns {Promise<{ candidates?: object[], untimed?: number, checked?: object, error: object|null }>}
 */
export async function loadBlockCandidates(db, { block, audience = 'manager', withContract = false, publishedShiftsOnly = false } = {}) {
  const manager = audience !== 'colleague'
  const who = manager ? 'manager' : 'colleague'
  // CANDIDATES.1 review 4 — contracted hours reach an owner, a manager or a
  // master only (the route decides withContract; a head coach is a manager
  // audience WITHOUT it). Off: no read, no field, no "not checked" note, and
  // the ranking falls back to fewest hours this week for everyone.
  const contract = manager && withContract === true
  const checked = manager
    ? { shifts: true, cross_studio: true, leave: true, availability: true, ...(contract ? { contract: true } : {}) }
    : { shifts: true, cross_studio: true }
  try {
    const onBlock = liveAssignments(block?.shift_assignments).map((a) => a.profile_id)
    const { members, error } = await readEligibleMembers(db, { locationId: block.location_id, excludeIds: onBlock })
    if (error) return { error }
    const ids = members.map((m) => m.profile_id)
    if (ids.length === 0) return { ...buildCandidates({ block, members, checked, audience: who }), checked, error: null }

    const { ids: siblingIds, error: sibErr } = await settle(() => siblingLocationIds(db, block.location_id))
    if (sibErr) {
      checked.cross_studio = false
      logWarn('candidates', 'sibling studios unreadable; candidates check this studio only', { blockId: block.id, err: sibErr.message })
    }
    const scopeIds = [block.location_id, ...(siblingIds || []).filter((id) => id && id !== block.location_id)]
    const monday = mondayOf(block.block_date)
    const employees = members.filter((m) => isWorkingTimeCovered(m.employment_type)).map((m) => m.profile_id)
    const memberIds = new Set(ids)

    // Each read settles on its own (settle): one that throws clears only its
    // own checked flag, and never costs the others their answer.
    const [shiftRead, leaveRead, availRead, contractRead, qualRead] = await Promise.all([
      // A coach is never told of a draft (ROSTER-FIX.1 D1): published rosters
      // only for the colleague audience. A manager counts drafts, as WORKTIME.
      settle(() => readOrgShiftRows(db, {
        locationId: block.location_id, scopeIds, profileIds: ids,
        from: addDaysISO(monday, -1), to: addDaysISO(monday, 7), publishedOnly: !manager || publishedShiftsOnly === true,
      })),
      manager ? settle(() => readApprovedLeaveOn(db, ids, block.block_date)) : null,
      manager ? settle(() => readStudioAvailability(db, { locationId: block.location_id, startDate: block.block_date, endDate: block.block_date })) : null,
      contract ? settle(() => readContractedHours(db, employees)) : null,
      // QUALS.1 — manager only: a colleague never learns a colleague's qualifications.
      manager && block.template_id ? settle(() => readBlockQualificationFacts(db, { templateId: block.template_id, profileIds: ids })) : null,
    ])

    const note = (facet, err) => {
      checked[facet] = false
      logWarn('candidates', `${facet} unreadable; candidates say so`, { blockId: block.id, err: err?.message })
    }
    if (shiftRead.error) note('shifts', shiftRead.error)
    let leave = []
    let rules = []
    let contracts = null
    if (manager) {
      if (leaveRead.error) note('leave', leaveRead.error)
      else leave = leaveRead.leave
      if (availRead.error) note('availability', availRead.error)
      else rules = (availRead.data || []).filter((r) => memberIds.has(r.profile_id))
      if (contract) {
        if (contractRead.error) note('contract', contractRead.error)
        else contracts = contractRead.byProfile
      }
    }

    const built = buildCandidates({
      block, members, shifts: shiftRead.error ? [] : shiftRead.shifts, leave, rules, contracts, checked, audience: who,
    })
    // QUALS.1 — attach the gaps AFTER ranking: they badge, they never re-rank.
    let candidates = contract ? built.candidates : withoutContract(built.candidates)
    if (qualRead?.error) note('qualifications', qualRead.error)
    else if (qualRead?.required?.length) {
      checked.qualifications = true
      candidates = attachQualificationGaps(candidates, { required: qualRead.required, records: qualRead.records, onISO: block.block_date })
    }
    return { ...built, candidates, checked, error: null }
  } catch (e) {
    return { error: { message: e?.message || 'candidates read threw' } }
  }
}
