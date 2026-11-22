// src/lib/shift-usual-coaches.js
//
// USUALCOACH.1 (mig 869) — the coaches who usually work a shift template, and
// the fill that puts them on its shifts.
//
// Two jobs:
//   checkUsualCoaches   the save rule: every id is a rosterable member of the
//                       template's studio (the same rule as the assign routes
//                       and the candidates list: readEligibleMembers).
//   fillUsualCoaches    put each shift's usual coaches on it. Used by the
//                       nightly horizon (only the shifts it has just created)
//                       and by POST /api/schedule/shifts/fill-usual (a week).
//
// The fill never overwrites and never double-books:
//   - a shift with ANY live coach on it is left alone (`already_staffed`): a
//     shift someone staffed is the manager's decision, not ours;
//   - a shift on a PUBLISHED roster is left alone (`published`): adding a coach
//     there is a change staff must be told about, and that is the manager's
//     step (assign by hand, which logs and notifies);
//   - each coach is judged by loadBlockCandidates, the same facts the assign
//     picker shows: not a current member (`not_at_studio`), already on an
//     overlapping shift at any studio of the organisation (`clash`), approved
//     leave that day (`time_off`), an availability rule saying they cannot
//     work then (`unavailable`), the shift already at its maximum
//     (`at_capacity`). Where the picker only warns, the fill skips: nobody is
//     there to read a warning at 3am.
//   - a fact that could not be read skips the shift's coaches (`unchecked`):
//     unknown is never an all-clear.
// Shifts are filled one at a time, in date and start order, and each
// candidates read is fresh, so a coach put on the 9am shift is busy for an
// overlapping 9:30 one in the same pass.
//
// Logs carry counts and ids only, never a name.
//
// Service-role client passed in: the CALLER is the access boundary (the route
// has checked the manager's studio; the cron runs for every studio).

import { readEligibleMembers, loadBlockCandidates } from './candidates-data'
import { liveAssignments } from './roster'
import { logWarn } from './log'

export const MAX_USUAL_COACHES = 50

export const USUAL_SKIP_REASONS = Object.freeze([
  'already_staffed', 'published', 'not_at_studio', 'clash', 'time_off',
  'unavailable', 'at_capacity', 'unchecked', 'already_on', 'write_failed',
])

const PAGE = 1000
const ID_CHUNK = 200

// One literal string, so check:select-columns resolves every column.
const FILL_BLOCK_SELECT = 'id, location_id, template_id, block_date, start_time, end_time, max_coaches, roster_id, rosters:roster_id(status), shift_templates(name, start_time, end_time, active, usual_coach_ids), shift_assignments(profile_id, status), locations(timezone)'

/** Ids in first-seen order, blanks and repeats dropped. Pure. */
export function normaliseUsualCoachIds(ids) {
  const out = []
  for (const id of ids || []) {
    if (typeof id === 'string' && id && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * USUALCOACH.1 — may these people be a template's usual coaches?
 * Every id must be an active, non-deleted member of `locationId`.
 *
 * @returns {Promise<{ ok: true, ids: string[] } | { ok: false, status: number, error: string }>}
 */
export async function checkUsualCoaches(db, { locationId, profileIds }) {
  const ids = normaliseUsualCoachIds(profileIds)
  if (ids.length === 0) return { ok: true, ids }
  if (ids.length > MAX_USUAL_COACHES) {
    return { ok: false, status: 400, error: `A template can have up to ${MAX_USUAL_COACHES} usual coaches.` }
  }
  const { members, error } = await readEligibleMembers(db, { locationId })
  if (error) return { ok: false, status: 500, error: 'Could not check the usual coaches.' }
  const here = new Set(members.map((m) => m.profile_id))
  const outside = ids.filter((id) => !here.has(id))
  if (outside.length > 0) {
    return {
      ok: false,
      status: 400,
      error: outside.length === 1
        ? 'One of the usual coaches is not active staff at this studio.'
        : `${outside.length} of the usual coaches are not active staff at this studio.`,
    }
  }
  return { ok: true, ids }
}

/**
 * The shifts a fill looks at: by id (the nightly horizon's new shifts) or a
 * studio's date range (a week). Paged / chunked under the 1,000-row cap.
 *
 * @returns {Promise<{ blocks: object[], error: object|null }>}
 */
export async function readBlocksForFill(db, { blockIds = null, locationId = null, startDate = null, endDate = null } = {}) {
  const blocks = []
  if (Array.isArray(blockIds)) {
    const ids = [...new Set(blockIds.filter(Boolean))]
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data, error } = await db.from('shift_blocks').select(FILL_BLOCK_SELECT).in('id', ids.slice(i, i + ID_CHUNK))
      if (error) return { blocks: [], error }
      blocks.push(...(data || []))
    }
    return { blocks, error: null }
  }
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('shift_blocks')
      .select(FILL_BLOCK_SELECT)
      .eq('location_id', locationId)
      .gte('block_date', startDate)
      .lte('block_date', endDate)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) return { blocks: [], error }
    blocks.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { blocks, error: null }
}

const factsChecked = (checked) => !!checked
  && checked.shifts !== false && checked.cross_studio !== false
  && checked.leave !== false && checked.availability !== false

/** Why this candidate must not be put on the shift, or null. Pure. */
export function usualCoachRefusal(candidate) {
  if (!candidate) return 'not_at_studio'
  if (candidate.free === false) return 'clash'
  if (candidate.on_leave) return 'time_off'
  if (candidate.unavailable) return 'unavailable'
  return null
}

/**
 * Put each block's usual coaches on it (see the header for every rule).
 *
 * @param {SupabaseClient} db  service role
 * @param {object[]} blocks    rows read by readBlocksForFill
 * @param {{ actorId?: string|null }} [opts]  assigned_by (null for the cron)
 * @returns {Promise<{ assigned: Array<{ block_id, profile_id, assignment_id }>,
 *   skipped: Array<{ block_id, profile_id: string|null, reason: string }>,
 *   counts: Record<string, number> }>}
 *   `skipped` names a coach per row (profile_id) except `already_staffed` /
 *   `published`, which are one row per shift. `counts` is by reason.
 */
export async function fillUsualCoaches(db, blocks, { actorId = null } = {}) {
  const assigned = []
  const skipped = []
  const skip = (blockId, profileId, reason) => skipped.push({ block_id: blockId, profile_id: profileId, reason })

  const ordered = (blocks || [])
    .filter((b) => b?.id && b.shift_templates?.active !== false
      && normaliseUsualCoachIds(b.shift_templates?.usual_coach_ids).length > 0)
    .sort((a, b) => String(a.block_date).localeCompare(String(b.block_date))
      || String(a.start_time).localeCompare(String(b.start_time))
      || String(a.id).localeCompare(String(b.id)))

  for (const block of ordered) {
    const usual = normaliseUsualCoachIds(block.shift_templates.usual_coach_ids)
    if (liveAssignments(block.shift_assignments).length > 0) { skip(block.id, null, 'already_staffed'); continue }
    if (block.rosters?.status === 'published') { skip(block.id, null, 'published'); continue }

    const facts = await loadBlockCandidates(db, { block, audience: 'manager' })
    if (facts.error || !factsChecked(facts.checked)) {
      logWarn('usual-coaches', 'coach facts unreadable; shift left for a manager', { blockId: block.id, err: facts.error?.message || null })
      for (const id of usual) skip(block.id, id, 'unchecked')
      continue
    }
    const byId = new Map((facts.candidates || []).map((c) => [c.profile_id, c]))
    let room = Math.max(0, Number(block.max_coaches) || 0)

    for (const profileId of usual) {
      if (room <= 0) { skip(block.id, profileId, 'at_capacity'); continue }
      const refusal = usualCoachRefusal(byId.get(profileId))
      if (refusal) { skip(block.id, profileId, refusal); continue }
      const { data, error } = await db
        .from('shift_assignments')
        .insert({ block_id: block.id, profile_id: profileId, assigned_by: actorId, notes: null })
        .select('id')
        .single()
      if (error) {
        if (error.code === '23505') { skip(block.id, profileId, 'already_on'); continue }
        logWarn('usual-coaches', 'assignment insert failed', { blockId: block.id, code: error.code || null, err: error.message })
        skip(block.id, profileId, 'write_failed')
        continue
      }
      assigned.push({ block_id: block.id, profile_id: profileId, assignment_id: data?.id ?? null })
      room -= 1
    }
  }

  const counts = {}
  for (const s of skipped) counts[s.reason] = (counts[s.reason] || 0) + 1
  return { assigned, skipped, counts }
}
