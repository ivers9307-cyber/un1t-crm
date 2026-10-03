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
 * The caller's OWN assignment ids in this payload: what the swap read is
 * bounded by. De-duplicated; never a colleague's row.
 */
export function ownShiftIds(rows, viewerId) {
  if (!viewerId) return []
  const ids = new Set()
  for (const r of rows || []) {
    if (r?.id && r.profile_id === viewerId) ids.add(r.id)
  }
  return [...ids]
}

// Ids per query. One open swap per shift (mig 599's index), so a chunk returns
// at most this many rows: far under the 1,000-row select cap, and ~4KB of
// `in.(…)` on the URL.
export const OWN_SWAP_ID_CHUNK = 100

/**
 * The caller's own open swaps ON THE GIVEN SHIFTS. This runs on the phone's
 * most-called feed, so it is bounded twice: by requester_id (a per-user row:
 * the owner check IS the access rule) and by the caller's own assignment ids in
 * the payload being returned, so a swap outside the window is never read and a
 * caller with no shift of their own costs no query at all. Never throws and
 * never fails the roster: a failed read is an empty list, which only costs the
 * chip.
 */
export async function fetchOwnOpenSwaps(db, requesterId, shiftIds) {
  const ids = Array.isArray(shiftIds) ? shiftIds.filter(Boolean) : []
  if (!requesterId || ids.length === 0) return []
  try {
    const out = []
    for (let i = 0; i < ids.length; i += OWN_SWAP_ID_CHUNK) {
      const { data, error } = await db.from('shift_swap_requests')
        .select('requester_shift_id, status')
        .eq('requester_id', requesterId)
        .in('requester_shift_id', ids.slice(i, i + OWN_SWAP_ID_CHUNK))
        .in('status', OPEN_SWAP_STATUSES)
      if (error) throw error
      out.push(...(data || []))
    }
    return out
  } catch (err) {
    logWarn('schedule', 'own open swaps read failed; shifts returned without open_swap_status', { err: err?.message || String(err) })
    return []
  }
}
