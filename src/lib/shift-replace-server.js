// src/lib/shift-replace-server.js
//
// REPLACE.1a — the DB half of "replace coach". Decisions are in
// ./shift-replace.js (pure); this file reads the context and does the ONE
// guarded move. Service-role client: the CALLER has already authorised the
// block's studio (assertLocationAccessOr404 + a manager role there).

import { SWAP_MOVE_CLEARS } from './swap-lifecycle'
import { OPEN_SWAP_STATUSES } from './swap-cover'
import { isLiveAssignment } from './roster'
import { REPLACE_SWAP_CLOSE_NOTE } from './shift-replace'
import { logError } from './log'

// shift_assignments has two FKs to profiles (profile_id, assigned_by), so the
// name embed names its column. The block carries what the rules, the log, the
// notice and the started check need: date, times, roster status, studio clock.
const REPLACE_ASSIGNMENT_SELECT = `
  id, profile_id, block_id, status, arrived_at, start_time_override,
  profiles!profile_id(full_name),
  shift_blocks!block_id(id, location_id, block_date, start_time, end_time, rosters:roster_id(status), shift_templates(name), locations(name, timezone))
`

const EMPTY = Object.freeze({ error: null, assignment: null, block: null, toIsMember: false, toProfile: null, liveOnBlockIds: [] })

/**
 * Everything POST /replace decides on. Any read error comes back as `error`
 * (the route answers 500): an unreadable membership or block must never read
 * as "not a member" or "nobody on it". B's profile is read only once B is a
 * proven member of the block's studio (the assign route's rule), so a foreign
 * id never produces a name.
 */
export async function readReplaceContext(db, { assignmentId, toProfileId }) {
  const { data: assignment, error: aErr } = await db.from('shift_assignments')
    .select(REPLACE_ASSIGNMENT_SELECT)
    .eq('id', assignmentId)
    .maybeSingle()
  if (aErr) return { ...EMPTY, error: aErr }
  if (!assignment) return { ...EMPTY }
  const block = assignment.shift_blocks || null
  if (!block?.location_id) return { ...EMPTY, assignment, block }

  const { data: links, error: mErr } = await db.from('profile_locations')
    .select('profile_id')
    .eq('location_id', block.location_id)
    .eq('profile_id', toProfileId)
    .limit(1)
  if (mErr) return { ...EMPTY, assignment, block, error: mErr }
  const toIsMember = (links || []).length > 0

  let toProfile = null
  if (toIsMember) {
    const { data: p, error: pErr } = await db.from('profiles')
      .select('id, full_name, active, deleted_at')
      .eq('id', toProfileId)
      .maybeSingle()
    if (pErr) return { ...EMPTY, assignment, block, error: pErr }
    toProfile = p || null
  }

  const { data: onBlock, error: bErr } = await db.from('shift_assignments')
    .select('id, profile_id, status')
    .eq('block_id', block.id)
  if (bErr) return { ...EMPTY, assignment, block, error: bErr }
  const liveOnBlockIds = (onBlock || []).filter(isLiveAssignment).map((r) => r.profile_id)

  return { error: null, assignment, block, toIsMember, toProfile, liveOnBlockIds }
}

/**
 * The move. Returns { ok: true, closedSwapIds } | { code } (a
 * refusal code for replaceRefusalResponse) | { error } (500).
 *
 *   1. B's cancelled tombstone on the block is deleted: the (block_id,
 *      profile_id) key (mig 067) does not care that it is cancelled.
 *   2. ONE UPDATE moves A's row to B under four guards: the id, A still owns
 *      it, it is live, A has not arrived. Zero rows = it changed since the read.
 *      23505 = B is on the block (the key is the race-proof half of the check).
 *      Everything that described A's shift is cleared (SWAP_MOVE_CLEARS +
 *      notes); B starts clean on the block's window.
 *   3. Open swaps about that row are closed as the manager's decision. A
 *      failure here is logged and the replace stands: the approval RPCs
 *      (mig 615) refuse such a swap as swap_stale.
 */
export async function replaceShiftAssignment(db, { assignment, toProfileId, actorId, nowIso }) {
  const { error: tombErr } = await db.from('shift_assignments')
    .delete()
    .eq('block_id', assignment.block_id)
    .eq('profile_id', toProfileId)
    .eq('status', 'cancelled')
  if (tombErr) return { error: tombErr }

  const { data: moved, error: moveErr } = await db.from('shift_assignments')
    .update({
      profile_id: toProfileId,
      status: 'scheduled',
      ...SWAP_MOVE_CLEARS,
      notes: null,
      assigned_by: actorId,
      assigned_at: nowIso,
    })
    .eq('id', assignment.id)
    .eq('profile_id', assignment.profile_id)
    .neq('status', 'cancelled')
    .is('arrived_at', null)
    .select('id')
  if (moveErr?.code === '23505') return { code: 'already_on_shift' }
  if (moveErr) return { error: moveErr }
  if (!moved || moved.length === 0) return { code: 'changed' }

  const { data: closed, error: swapErr } = await db.from('shift_swap_requests')
    .update({ status: 'cancelled', reviewed_by: actorId, reviewed_at: nowIso, review_note: REPLACE_SWAP_CLOSE_NOTE })
    .or(`requester_shift_id.eq.${assignment.id},target_shift_id.eq.${assignment.id}`)
    .in('status', [...OPEN_SWAP_STATUSES])
    .select('id')
  if (swapErr) {
    logError('shift-replace', 'replace: could not close the open swaps on the replaced shift; the swap approval refuses them as stale', {
      assignmentId: assignment.id, err: swapErr.message,
    })
    return { ok: true, closedSwapIds: [] }
  }
  return { ok: true, closedSwapIds: (closed || []).map((r) => r.id) }
}
