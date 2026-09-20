// src/lib/shift-open-swaps.js
//
// COVERLOOP.2 — "does this shift of MINE have an open swap?" for
// GET /api/schedule/shifts, so the phone's Schedule tab can chip the row and
// stop offering a second post (the route 409s one: mig 599's
// one-open-swap-per-shift index).
//
// Own rows only. A targeted swap between two colleagues is not visible to
// other coaches (COACHSCOPE.1), and this feed also serves the Team view: a
// manager reading everyone's rows gets the field on their own shifts and on
// nobody else's.

import { logWarn } from './log'

const OPEN_SWAP_STATUSES = ['pending', 'awaiting_approval']

/**
 * @param {Array<object>} rows     toApiShiftRow() results (id = the assignment id)
 * @param {Array<{requester_shift_id:string|null,status:string}>|null} swaps
 * @param {string|null} viewerId
 * @returns {Array<object>} new rows, each with open_swap_status: 'pending' | 'awaiting_approval' | null
 */
export function annotateOwnOpenSwaps(rows, swaps, viewerId) {
  const byShift = new Map()
  for (const s of swaps || []) {
    if (s?.requester_shift_id && OPEN_SWAP_STATUSES.includes(s.status)) byShift.set(s.requester_shift_id, s.status)
  }
  return (rows || []).map((r) => ({
    ...r,
    open_swap_status: viewerId && r.profile_id === viewerId ? (byShift.get(r.id) ?? null) : null,
  }))
}

/**
 * The caller's own open swaps. Scoped by requester_id (a per-user row: the
 * owner check IS the access rule). Never throws and never fails the roster: a
 * failed read is an empty list, which only costs the chip.
 */
export async function fetchOwnOpenSwaps(db, requesterId) {
  if (!requesterId) return []
  const { data, error } = await db.from('shift_swap_requests')
    .select('requester_shift_id, status')
    .eq('requester_id', requesterId)
    .in('status', OPEN_SWAP_STATUSES)
  if (error) {
    logWarn('schedule', 'own open swaps read failed; shifts returned without open_swap_status', { err: error.message })
    return []
  }
  return data || []
}
