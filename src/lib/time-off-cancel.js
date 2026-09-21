// LEAVECANCEL.1 — cancelling APPROVED leave that is your own.
//
// The owner's rule (20 Sep 2026): "A manager cancelling their OWN APPROVED
// leave must need the OWNER's approval." Approved leave moves the holiday
// allowance (the mig 011/616 trigger) and other people plan the roster around
// it, so the person it belongs to cannot take it back on their own say-so.
//
//   • WHO MUST ASK. Anyone whose role lets them through the PUT's self gate:
//     manager-tier (MANAGER_ROLES) at the studio the leave was filed at or at
//     any studio they belong to. An owner asks too, and needs a DIFFERENT
//     owner. A master cancels directly, as before. A plain coach's own approved
//     leave stays refused by the PUT exactly as before (out of scope here).
//   • THE ASK IS NOT A STATUS (mig 624). While it waits, the leave is still
//     `approved` and still in force for every reader. An ask is OPEN while it
//     is undecided, the leave is still approved, and the leave has not ended:
//     like a pending request's expiry (LEAVE.2) the lapse is derived at read
//     time, never stored.
//   • WHO DECIDES. An OWNER at a studio the request belongs to, or a master,
//     and never the requester. Deliberately role-based: NOT managers, NOT head
//     coaches, and NOT the time-off approval permission (canDecideTimeOff),
//     which governs ordinary leave decisions.
//
// Pure apart from resolveLeaveCancelDeciderIds. Shared by the PUT, the
// cancel-request route, the list GET and the approvals provider, so the four
// can never disagree about who may do what.

import { hasRoleAtLocation } from '@/lib/role-at-location'
import { MANAGER_ROLES } from '@/lib/schemas'

export const LEAVE_CANCEL_DECIDER_ROLES = Object.freeze(['owner'])

/** The studios a request belongs to: filed-at plus every studio of the requester (LEAVE.2). Pure. */
export function leaveActingLocationIds(row, requesterLocationIds = []) {
  return [...new Set([row?.location_id, ...(requesterLocationIds || [])].filter(Boolean))]
}

/** Asked, undecided, still approved, and not yet over. `todayIso` is the Dublin business day. Pure. */
export function isOpenCancelAsk(row, todayIso) {
  return !!row && !!row.cancel_requested_at && !row.cancel_decided_at &&
    row.status === 'approved' && !!row.end_date && !!todayIso && row.end_date >= todayIso
}

/**
 * null (never asked, or withdrawn) | 'open' | 'approved' | 'rejected' |
 * 'lapsed' (asked and never decided, but the leave ended or stopped being
 * approved by another route, so there is nothing left to decide). Pure.
 */
export function cancelAskState(row, todayIso) {
  if (!row?.cancel_requested_at) return null
  if (row.cancel_decided_at) return row.cancel_decision === 'approved' ? 'approved' : 'rejected'
  return isOpenCancelAsk(row, todayIso) ? 'open' : 'lapsed'
}

/**
 * What "cancel" means for the caller's OWN APPROVED leave:
 *   'direct' a master, as before
 *   'ask'    manager-tier: record the ask, an owner decides
 *   'ended'  manager-tier, but the last day has passed: nothing to give back
 *   null     not theirs, not approved, or a plain coach (the PUT's existing
 *            refusal stands)
 * Leave that has started but not finished can still be asked about; the
 * decider judges it. Pure.
 */
export function selfCancelMode(user, row, todayIso, requesterLocationIds = []) {
  if (!user?.id || !row || row.profile_id !== user.id || row.status !== 'approved') return null
  if (user.profileRole === 'master') return 'direct'
  const managerTier = leaveActingLocationIds(row, requesterLocationIds).some((id) => hasRoleAtLocation(user, id, MANAGER_ROLES))
  if (!managerTier) return null
  return row.end_date && todayIso && row.end_date < todayIso ? 'ended' : 'ask'
}

/** Is the caller an OWNER at a studio this request belongs to? (hasRoleAtLocation says yes to a master.) Pure. */
export function isOwnerForLeave(user, row, requesterLocationIds = []) {
  return leaveActingLocationIds(row, requesterLocationIds).some((id) => hasRoleAtLocation(user, id, LEAVE_CANCEL_DECIDER_ROLES))
}

/** May this caller approve or reject the cancellation? Never the requester. Pure. */
export function canDecideLeaveCancel(user, row, requesterLocationIds = []) {
  if (!user?.id || !row || user.id === row.profile_id) return false
  return isOwnerForLeave(user, row, requesterLocationIds)
}

/**
 * What GET /api/schedule/time-off tells the screen about one row, for THIS
 * caller. The screen offers exactly these and the routes re-judge every one.
 */
export function annotateCancelAsk(row, user, todayIso, requesterLocationIds = []) {
  const state = cancelAskState(row, todayIso)
  const open = state === 'open'
  const isSelf = !!user?.id && row?.profile_id === user.id
  const mode = selfCancelMode(user, row, todayIso, requesterLocationIds)
  return {
    cancel_request_state: state,
    // 'direct' counts: a master's own approved leave gets the same button, and
    // the PUT's answer says which of the two happened.
    can_request_cancel: !open && (mode === 'ask' || mode === 'direct'),
    can_withdraw_cancel: open && isSelf,
    can_decide_cancel: open && canDecideLeaveCancel(user, row, requesterLocationIds),
  }
}

/**
 * Narrow a time_off_requests query to OPEN asks. The same four conditions as
 * isOpenCancelAsk, and the ones mig 624's partial index is built on.
 */
export function applyOpenCancelAskFilter(query, todayIso) {
  return query
    .eq('status', 'approved')
    .not('cancel_requested_at', 'is', null)
    .is('cancel_decided_at', null)
    .gte('end_date', todayIso)
}

/**
 * Who is told about an ask, and who the PUT counts as "someone can decide
 * this": active OWNERS at the studios the request belongs to, never the
 * requester. Only when there is none are the estate's active masters read
 * (masters hold no per-studio rows). A failed read is returned as the error:
 * guessing "nobody" would refuse an ask that has a decider, and guessing
 * "somebody" would record one nobody will ever hear about.
 *
 * @returns {Promise<{ ownerIds: string[], masterIds: string[], error: object|null }>}
 */
export async function resolveLeaveCancelDeciderIds(db, locationIds, requesterId) {
  const ids = [...new Set((locationIds || []).filter(Boolean))]
  if (ids.length === 0) return { ownerIds: [], masterIds: [], error: null }

  const { data: links, error } = await db
    .from('profile_locations')
    .select('profile_id, location_id, role, profiles!inner(id, role, active, deleted_at)')
    .in('location_id', ids)
    .eq('role', 'owner')
  if (error) return { ownerIds: [], masterIds: [], error }
  const ownerIds = [...new Set((links || [])
    .filter((l) => l?.profiles?.active && !l.profiles.deleted_at && l.profile_id !== requesterId)
    .map((l) => l.profile_id))]
  if (ownerIds.length > 0) return { ownerIds, masterIds: [], error: null }

  // A tombstone is role='staff' + active=false (mig 622), so both filters drop it.
  const { data: masters, error: mastersError } = await db
    .from('profiles')
    .select('id')
    .eq('role', 'master')
    .eq('active', true)
  if (mastersError) return { ownerIds: [], masterIds: [], error: mastersError }
  return {
    ownerIds: [],
    masterIds: [...new Set((masters || []).map((m) => m.id).filter((id) => id && id !== requesterId))],
    error: null,
  }
}

/**
 * Dedup key for a notice about ONE ask. push-dedup keys must be replay-safe,
 * so this is built from the row's stored cancel_requested_at (entity state,
 * not the clock of the call): a replay of the same ask is swallowed, a second
 * ask after a decline is a new event and notifies again.
 */
export function cancelAskEventKey(prefix, row) {
  return `${prefix}:${row.id}:${row.cancel_requested_at}`
}

export function leaveRangeText(row) {
  return row.start_date === row.end_date ? row.start_date : `${row.start_date} to ${row.end_date}`
}
