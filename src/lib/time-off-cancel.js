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
import { dublinTimeLabel, dublinDateKey } from '@/lib/dublin-time'

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

// ── LEAVEGUARD.1 — a colleague taking a manager's APPROVED leave out of force ──
//
// LEAVECANCEL.1 made a manager's cancel of their OWN approved leave an ask an
// owner decides. The plain PUT still let any manager-tier COLLEAGUE set that
// same leave to cancelled / rejected / pending outright, so two managers could
// cancel each other's leave and walk around the rule. The rule, as built (the
// owner may reverse it; it is a default, not their words):
//
//   • Moving APPROVED leave to any other status, when the person it belongs
//     to holds a manager-tier role (MANAGER_ROLES) at ANY studio the request
//     belongs to, needs the SAME decider as a cancellation ask: an OWNER at a
//     studio the request belongs to who is not the requester, or a master
//     (canDecideLeaveCancel). An owner's leave therefore needs another owner.
//   • Plain staff leave: unchanged, managers keep cancelling/rejecting it.
//   • Pending leave: unchanged (deciding it is canDecideTimeOff's question).
//   • Approved -> approved (an approver re-stamping it) changes no state and
//     is not gated.
//   • The requester's own leave is LEAVECANCEL.1's path, not this one.
// Role is per studio, read from the requester's profile_locations (never
// `profiles.role`, never the caller's active studio).

/** The refusal. Says what to do instead, not only "no". No em-dashes. */
export const APPROVED_LEAVE_OWNER_ONLY_ERROR =
  'Only an owner can cancel a manager\'s approved leave. Ask the person whose leave it is to request the cancellation, or ask an owner.'

/**
 * Does the requester hold a manager-tier role at a studio this request
 * belongs to? `memberships` are their profile_locations rows
 * ({ location_id, role }). Pure.
 */
export function isManagerTierRequester(memberships, row, requesterLocationIds = []) {
  const acting = new Set(leaveActingLocationIds(row, requesterLocationIds))
  return (memberships || []).some((m) => acting.has(m?.location_id) && MANAGER_ROLES.includes(m?.role))
}

/**
 * LEAVEGUARD.1 — may `user` move this leave to `nextStatus`, as far as THIS
 * rule goes? true = the rule has no objection (every other gate in the PUT
 * still applies). `requesterIsManagerTier` null means "could not be read" and
 * is judged as manager-tier: authority only ever narrows on a failed read.
 * Pure.
 */
export function approvedLeaveGuardAllows(user, row, nextStatus, requesterLocationIds = [], requesterIsManagerTier = null) {
  if (!row || row.status !== 'approved' || nextStatus === 'approved') return true
  if (user?.id && user.id === row.profile_id) return true
  if (requesterIsManagerTier === false) return true
  return canDecideLeaveCancel(user, row, requesterLocationIds)
}

/**
 * The list GET's per-row flag. `approved_locked_to_owner: true` = this is a
 * colleague's APPROVED leave that only an owner may take out of force, and
 * the caller is not one, so a screen must not offer Cancel / Reject / Reopen
 * on it. Deliberately a REFUSAL flag: absent (an older server, which accepts
 * the action) reads as "not locked", so a client reading `=== true` keeps
 * today's behaviour against a server that predates the rule. Pure.
 */
export function annotateApprovedLeaveGuard(row, user, requesterLocationIds = [], requesterIsManagerTier = null) {
  return { approved_locked_to_owner: !approvedLeaveGuardAllows(user, row, 'cancelled', requesterLocationIds, requesterIsManagerTier) }
}

/**
 * What GET /api/schedule/time-off tells the screen about one row, for THIS
 * caller. The screen offers exactly these and the routes re-judge every one.
 * `nowMs` is passed in (the route's clock) so the 24h re-ask wait agrees with
 * the PUT that enforces it.
 */
export function annotateCancelAsk(row, user, todayIso, requesterLocationIds = [], nowMs = Date.now()) {
  const state = cancelAskState(row, todayIso)
  const open = state === 'open'
  const isSelf = !!user?.id && row?.profile_id === user.id
  const mode = selfCancelMode(user, row, todayIso, requesterLocationIds)
  // Within 24h of a decline the PUT refuses a re-ask (reAskBlockedUntil); the
  // button must not show and then 409. Only an ASK waits: a master's cancel is
  // direct and notifies nobody.
  const retryAfter = mode === 'ask' ? reAskBlockedUntil(row, nowMs) : null
  const canAsk = !open && !retryAfter
  return {
    cancel_request_state: state,
    // 'direct' counts: a master's own approved leave gets the same button, and
    // the PUT's answer says which of the two happened.
    can_request_cancel: canAsk && (mode === 'ask' || mode === 'direct'),
    // true = the button ASKS an owner; false with can_request_cancel = a
    // master, whose cancel is immediate. The screen words its confirm from it.
    cancel_needs_owner: canAsk && mode === 'ask',
    // When the wait lifts: the instant, and the Dublin wall-clock words for it.
    cancel_retry_after: retryAfter,
    cancel_retry_after_label: retryAfter ? dublinRetryLabel(retryAfter) : null,
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

/**
 * Dedup key for the notice that an ask was MADE: one per leave per UTC hour of
 * the stored cancel_requested_at. A withdraw clears the row, so nothing on it
 * remembers the earlier ask; bucketing the key is what stops withdraw + re-ask
 * from paging every owner again minutes later. Still replay-safe (it is the
 * stored value, not the call's clock), and a re-ask after a decline is at
 * least 24h on (reAskBlockedUntil), so it always lands in a new bucket.
 */
export function cancelAskNoticeKey(row) {
  return `time_off_cancel_ask:${row.id}:${String(row.cancel_requested_at).slice(0, 13)}`
}

const RE_ASK_AFTER_DECLINE_MS = 24 * 60 * 60 * 1000

/**
 * After a DECLINE the same leave cannot be asked about again for 24h: every
 * ask notifies every owner. Returns the ISO instant the wait ends, or null
 * when the person is free to ask. Pure.
 */
export function reAskBlockedUntil(row, nowMs) {
  if (!row?.cancel_decided_at || row.cancel_decision !== 'rejected') return null
  const until = Date.parse(row.cancel_decided_at) + RE_ASK_AFTER_DECLINE_MS
  return Number.isFinite(until) && nowMs < until ? new Date(until).toISOString() : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "14:30 on 22 Sep": an instant as Dublin wall-clock words, whatever the
 * process timezone. The time is the house helper's; the day is built from
 * dublinDateKey with a fixed month list, because ICU's en-GB short month for
 * September varies between versions ("Sep" / "Sept"). null if unreadable. Pure.
 */
export function dublinRetryLabel(iso) {
  const time = dublinTimeLabel(iso)
  if (!time) return null
  const [, m, d] = dublinDateKey(iso).split('-').map(Number)
  return `${time} on ${d} ${MONTHS[m - 1]}`
}

/** All seven mig 624 columns back to NULL: a withdraw, or an ask dying with the state it was about. */
export const CLEARED_CANCEL_ASK = Object.freeze({
  cancel_requested_at: null, cancel_requested_by: null, cancel_request_note: null,
  cancel_decided_at: null, cancel_decided_by: null, cancel_decision: null, cancel_decision_note: null,
})

// LEAVECANCEL.1 — the error class "mig 624 is not applied here". Code reaches
// prod before its migration whenever a Vercel PREVIEW of the branch runs, or
// on an ordering slip, and then:
//   PGRST200  PostgREST cannot find the relationship an embed hint names
//             (cancel_decider:profiles!cancel_decided_by: the FK is mig 624's)
//   42703     Postgres undefined_column (a filter/order/select on cancel_*)
//   PGRST204  PostgREST's schema cache has no such column (a write of cancel_*)
// The CODE alone is not enough: the same codes mean a real bug anywhere else,
// and must stay errors. So the error text must also name a cancel_* column;
// PostgREST puts the hint in `details` for PGRST200, the column in `message`
// for the other two.
const MISSING_SCHEMA_CODES = new Set(['PGRST200', '42703', 'PGRST204'])
export function isMissingCancelSchemaError(err) {
  if (!err || !MISSING_SCHEMA_CODES.has(err.code)) return false
  return /\bcancel_(requested|decided|decision|request)/.test(`${err.message || ''} ${err.details || ''} ${err.hint || ''}`)
}

/** Annotations for a row when the feature is not there (pre-mig 624): nothing offered, nothing waiting. */
export const CANCEL_ASK_OFF = Object.freeze({
  cancel_request_state: null, can_request_cancel: false, cancel_needs_owner: false,
  can_withdraw_cancel: false, can_decide_cancel: false, cancel_retry_after: null, cancel_retry_after_label: null,
})

export function leaveRangeText(row) {
  return row.start_date === row.end_date ? row.start_date : `${row.start_date} to ${row.end_date}`
}
