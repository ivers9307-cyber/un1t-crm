// SCHEDULE-CHANGE-LOG.1 — audit + re-notify helpers for edits to an
// already-published roster.
//
// logRosterChange() records an edit ONLY when the affected block belongs
// to a published roster (draft edits aren't audited — those ride the
// normal first-publish notification). On a re-publish, the publish path
// reads the still-unnotified rows (collectUnnotifiedChanges), re-notifies
// the distinct coaches, and stamps them (markChangesNotified) so they
// aren't re-pinged next time.

import { logWarn } from './log'

export const ROSTER_CHANGE_ACTIONS = ['assigned', 'unassigned', 'time_changed']

/**
 * Record a post-publish roster edit. Best-effort — never throws.
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {object} change
 * @param {boolean} change.isPublished  the block's roster is published
 * @param {string}  change.locationId
 * @param {string}  change.action       one of ROSTER_CHANGE_ACTIONS
 * @param {string}  change.coachId
 * @param {string}  [change.actorId]
 * @param {string}  [change.blockId]
 * @param {string}  [change.blockDate]  YYYY-MM-DD
 * @param {object}  [change.details]
 * @returns {Promise<{logged: boolean, reason?: string}>}
 */
export async function logRosterChange(db, change = {}) {
  try {
    if (!change.isPublished) return { logged: false, reason: 'not_published' }
    if (!ROSTER_CHANGE_ACTIONS.includes(change.action)) return { logged: false, reason: 'bad_action' }
    if (!change.locationId || !change.coachId) return { logged: false, reason: 'missing' }
    await db.from('roster_change_log').insert({
      location_id: change.locationId,
      block_id: change.blockId || null,
      block_date: change.blockDate || null,
      actor_id: change.actorId || null,
      coach_id: change.coachId,
      action: change.action,
      details: change.details || {},
    })
    return { logged: true }
  } catch (e) {
    logWarn('roster-change-log', 'insert failed', { err: e?.message })
    return { logged: false, reason: 'error' }
  }
}

/** Distinct coach ids from change-log rows. Pure. */
export function distinctCoachIds(rows) {
  return [...new Set((rows || []).map((r) => r?.coach_id).filter(Boolean))]
}

/**
 * Still-unnotified post-publish changes in a period — the coaches the next
 * (re-)publish should re-notify. Best-effort; returns [].
 */
export async function collectUnnotifiedChanges(db, { locationId, periodStart, periodEnd } = {}) {
  if (!locationId || !periodStart || !periodEnd) return []
  try {
    const { data } = await db
      .from('roster_change_log')
      .select('id, coach_id, action')
      .eq('location_id', locationId)
      .gte('block_date', periodStart)
      .lte('block_date', periodEnd)
      .is('notified_at', null)
    return data || []
  } catch (e) {
    logWarn('roster-change-log', 'collect failed', { err: e?.message })
    return []
  }
}

/** Stamp notified_at on the given change rows. Best-effort. */
export async function markChangesNotified(db, rowIds) {
  if (!rowIds || rowIds.length === 0) return
  try {
    await db
      .from('roster_change_log')
      .update({ notified_at: new Date().toISOString() })
      .in('id', rowIds)
  } catch (e) {
    logWarn('roster-change-log', 'mark notified failed', { err: e?.message })
  }
}
