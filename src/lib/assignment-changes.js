// Audit + guard helpers for the master admin matrix v2 (mig 080).
//
// Three responsibilities:
//   1. countActiveMasters / wouldLeaveZeroMasters — guard the
//      "platform must always have at least one active master"
//      invariant from the application layer. The DB trigger
//      enforces the same invariant unconditionally; this is the
//      friendly-error layer that tells the user WHY before they
//      hit the trigger.
//   2. logAssignmentChange — append-only writer to
//      assignment_change_log. Best-effort: failures here log a
//      warning but never throw, because losing an audit row should
//      not block a successful mutation. (The mutation itself
//      should always be the user-visible thing; audit is operational
//      debt-tracking on top.)
//   3. canRemoveSelfFromLastOwnerLocation — niche but real safety
//      check. Today only used inside delete-assignment, but kept as
//      a separate exported predicate so future routes can reuse.
//
// All functions take a service-role db (createServerClient) — the
// caller's authentication has already been verified via
// getCurrentUser at the route boundary.

import { logWarn } from './log'

const MASTER_ROLE = 'master'

/**
 * Count active masters platform-wide.
 *
 * @param {SupabaseClient} db service-role client
 * @returns {Promise<number>}
 */
export async function countActiveMasters(db) {
  const { count, error } = await db
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .eq('role', MASTER_ROLE)
    .eq('active', true)
  if (error) {
    throw new Error(`countActiveMasters failed: ${error.message}`)
  }
  return count || 0
}

/**
 * Would performing `action` on `targetProfileId` leave zero active masters?
 *
 * Action shapes:
 *   - 'demote'      — role flipping from 'master' to anything else
 *   - 'deactivate'  — active flipping from true to false
 *   - 'delete'      — hard delete
 *
 * For all three, we count masters EXCLUDING the target. If the result
 * is zero AND the target is currently an active master, the operation
 * would leave zero — return true (i.e., the operation should be blocked).
 *
 * @param {SupabaseClient} db
 * @param {string} targetProfileId
 * @returns {Promise<{ wouldLeave: boolean, currentMasters: number, targetIsActiveMaster: boolean }>}
 */
export async function wouldLeaveZeroMasters(db, targetProfileId) {
  // Two-query check — needs to know whether the target IS an active master
  // (because if not, the operation can't reduce the count) AND the count of
  // OTHER active masters.
  const [
    { data: target, error: targetErr },
    { count: othersCount, error: othersErr },
  ] = await Promise.all([
    db.from('profiles').select('role, active').eq('id', targetProfileId).single(),
    db
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('role', MASTER_ROLE)
      .eq('active', true)
      .neq('id', targetProfileId),
  ])

  if (targetErr) throw new Error(`wouldLeaveZeroMasters target lookup failed: ${targetErr.message}`)
  if (othersErr) throw new Error(`wouldLeaveZeroMasters count failed: ${othersErr.message}`)

  const targetIsActiveMaster = !!(target && target.role === MASTER_ROLE && target.active)
  const others = othersCount || 0

  return {
    wouldLeave: targetIsActiveMaster && others === 0,
    currentMasters: others + (targetIsActiveMaster ? 1 : 0),
    targetIsActiveMaster,
  }
}

/**
 * Append an entry to assignment_change_log. Best-effort.
 *
 * @param {SupabaseClient} db
 * @param {object} args
 * @param {string|null} args.actorId          Master who performed the change. NULL for system actions.
 * @param {string} args.targetProfileId       User being affected. Required.
 * @param {string|null} [args.locationId]     Set for assignment-scoped actions; NULL for profile-level.
 * @param {string} args.action                One of: assignment_create, assignment_update, assignment_delete, master_promote, master_demote, profile_deactivate, profile_reactivate.
 * @param {object|null} [args.before]         JSONB snapshot before the change. NULL for creates.
 * @param {object|null} [args.after]          JSONB snapshot after the change. NULL for deletes.
 * @returns {Promise<{ logged: boolean, error?: string }>}
 */
export async function logAssignmentChange(db, {
  actorId,
  targetProfileId,
  locationId = null,
  action,
  before = null,
  after = null,
}) {
  if (!targetProfileId || !action) {
    return { logged: false, error: 'missing_required_field' }
  }
  try {
    const { error } = await db.from('assignment_change_log').insert({
      actor_id: actorId,
      target_profile_id: targetProfileId,
      location_id: locationId,
      action,
      before,
      after,
    })
    if (error) {
      logWarn('assignment-changes', 'audit insert failed', { err: error })
      return { logged: false, error: error.message }
    }
    return { logged: true }
  } catch (e) {
    logWarn('assignment-changes', `audit threw`, { err: e })
    return { logged: false, error: e?.message || 'unknown' }
  }
}

/**
 * Self-protection: would removing the actor from `locationId` leave the actor
 * with no owner-tier assignments anywhere? If so, block the operation —
 * an owner shouldn't be able to lock themselves out of their own platform.
 *
 * Only invoked when actor === target (you're editing your own assignments).
 * Other-user edits skip this check.
 *
 * @param {SupabaseClient} db
 * @param {string} actorId
 * @param {string} targetProfileId
 * @param {string} locationId  The assignment about to be removed.
 * @returns {Promise<{ wouldOrphan: boolean, otherOwnerLocationCount: number }>}
 */
export async function canRemoveSelfFromLastOwnerLocation(db, actorId, targetProfileId, locationId) {
  if (actorId !== targetProfileId) {
    // Not editing self — no self-orphan risk.
    return { wouldOrphan: false, otherOwnerLocationCount: -1 }
  }

  const { count, error } = await db
    .from('profile_locations')
    .select('*', { count: 'exact', head: true })
    .eq('profile_id', targetProfileId)
    .eq('role', 'owner')
    .neq('location_id', locationId)

  if (error) {
    throw new Error(`canRemoveSelfFromLastOwnerLocation failed: ${error.message}`)
  }

  return {
    wouldOrphan: (count || 0) === 0,
    otherOwnerLocationCount: count || 0,
  }
}
