// src/lib/swap-conflicts.js
//
// SWAPS.2 — the DB half of the swap leave / same-day clash check. For each
// move swapIncomingMoves() describes, read the coach's approved time off
// covering the block's date and their assignments that day, then let the
// pure evaluateSwapMoveConflicts() decide and swapConflictMessage() word it.
//
// Scope is by PERSON, not studio: leave is per profile, and a coach cannot be
// at two studios at once, so neither read carries a location filter. Callers
// (PUT /api/schedule/swaps/[id]) have already location-gated the swap itself.
//
// Never throws. A read that fails becomes a `check_failed` conflict for that
// coach rather than a silent "no conflicts": the approval path refuses on it
// (the manager can confirm past it) and the claim path drops it from the
// coach's warnings.

import { evaluateSwapMoveConflicts, swapConflictMessage } from './swap-lifecycle'
import { logWarn } from './log'

/**
 * @param {object} db     service-role supabase client
 * @param {Array<object>} moves  swapIncomingMoves(...) output
 * @param {object} [opts]
 * @param {string} [opts.viewerId]  the acting user; their own conflicts read "You ..."
 * @returns {Promise<Array<object & { message: string }>>}
 */
export async function findSwapConflicts(db, moves, { viewerId } = {}) {
  const conflicts = []
  for (const move of moves || []) {
    const date = move?.block?.block_date
    if (!move?.coachId || !date) continue
    try {
      const [leaveRes, assignRes] = await Promise.all([
        db.from('time_off_requests')
          .select('id, profile_id, type, start_date, end_date, status')
          .eq('profile_id', move.coachId)
          .eq('status', 'approved')
          .lte('start_date', date)
          .gte('end_date', date),
        db.from('shift_assignments')
          .select('id, profile_id, block_id, status, start_time_override, end_time_override, shift_blocks!inner(id, block_date, start_time, end_time, shift_templates(name), locations(name))')
          .eq('profile_id', move.coachId)
          .eq('shift_blocks.block_date', date),
      ])
      if (leaveRes.error || assignRes.error) {
        throw new Error(leaveRes.error?.message || assignRes.error?.message)
      }
      conflicts.push(...evaluateSwapMoveConflicts(move, { timeOff: leaveRes.data, assignments: assignRes.data }))
    } catch (e) {
      logWarn('swaps', 'swap conflict check failed', { coachId: move.coachId, date, err: e?.message })
      conflicts.push({ kind: 'check_failed', role: move.role, coachId: move.coachId, date })
    }
  }
  if (conflicts.length === 0) return []

  // Names for the sentences — only for coaches who are not the viewer.
  // Best-effort: a failed read words them as "This coach".
  const others = [...new Set(conflicts.map((c) => c.coachId).filter((id) => id && id !== viewerId))]
  const names = new Map()
  if (others.length) {
    try {
      const { data, error } = await db.from('profiles').select('id, full_name').in('id', others)
      if (error) throw new Error(error.message)
      for (const p of data || []) names.set(p.id, p.full_name)
    } catch (e) {
      logWarn('swaps', 'swap conflict names lookup failed', { err: e?.message })
    }
  }

  return conflicts.map((c) => ({
    ...c,
    message: swapConflictMessage(c, { name: names.get(c.coachId), isViewer: !!viewerId && c.coachId === viewerId }),
  }))
}
