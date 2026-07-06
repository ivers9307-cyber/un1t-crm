// src/lib/swap-lifecycle.js
//
// Pure decision function for shift-swap state transitions. The route
// (PUT /api/schedule/swaps/[id]) fetches the swap row (with requester_shift /
// target_shift assignment embeds) and a user, calls resolveSwapTransition,
// then executes the returned swapUpdates + assignmentOps + notify. Keeping the
// logic pure makes the whole lifecycle unit-testable without a DB.
//
// Lifecycle: pending -> awaiting_approval -> (approved | rejected); plus
// cancelled. See docs/superpowers/plans/2026-06-17-coach-today-roster-phase3.md.

import { MANAGER_ROLES } from './schemas'

export const TERMINAL_SWAP_STATES = ['approved', 'rejected', 'cancelled']

// Statuses a client may request on PUT /api/schedule/swaps/[id].
const REQUESTABLE = ['awaiting_approval', 'approved', 'rejected', 'cancelled', 'pending']

function deny(status, error) {
  return { ok: false, status, error, swapUpdates: null, assignmentOps: [], notify: [], effect: 'denied' }
}

/**
 * @param {object} args
 * @param {object} args.swap       full swap row + requester_shift/target_shift embeds (profile_id read)
 * @param {string} args.requestedStatus
 * @param {object} args.user       { id, role }
 * @param {string[]} args.userLocationIds  the caller's location ids
 * @param {string|null} [args.reviewNote]
 * @param {string} [args.nowIso]   injectable timestamp (defaults to new Date().toISOString())
 * @param {boolean} [args.canApprove]  gates the "approved" transition (passed in by the route).
 *   Defaults to the manager check when omitted — see APPROVALS-PERCAT.1 below.
 * @returns {{ ok:boolean, status?:number, error?:string,
 *   swapUpdates:object|null, assignmentOps:Array<{id:string,set:object}>,
 *   notify:Array<{kind:string,to?:string[]}>, effect:string }}
 */
export function resolveSwapTransition({ swap, requestedStatus, user, userLocationIds, reviewNote = null, nowIso, canApprove }) {
  if (!swap) return deny(404, 'Swap request not found')
  if (!user) return deny(401, 'Unauthorized')
  if (!REQUESTABLE.includes(requestedStatus)) return deny(400, 'Invalid status')

  const isManager = MANAGER_ROLES.includes(user.role)
  // APPROVALS-PERCAT.1 — the "approve" transition is gated by the
  // approvals_shift_swaps permission (passed in by the route). Claim /
  // accept / reject-by-target keep using isManager. Default preserves the
  // old behaviour for any caller that doesn't pass canApprove.
  const mayApprove = typeof canApprove === 'boolean' ? canApprove : isManager
  const isRequester = swap.requester_id === user.id
  const isTarget = !!swap.target_id && swap.target_id === user.id
  const atLocation = Array.isArray(userLocationIds) && userLocationIds.includes(swap.location_id)

  // Terminal states accept no further transitions.
  if (TERMINAL_SWAP_STATES.includes(swap.status)) {
    return deny(409, `Swap already ${swap.status}`)
  }

  // ── Requester cancels their own swap (any non-terminal state) ──
  if (requestedStatus === 'cancelled') {
    if (isRequester || isManager) {
      return { ok: true, status: 200, effect: 'cancelled', assignmentOps: [], notify: [],
        swapUpdates: { status: 'cancelled' } }
    }
    return deny(403, 'Only the requester or a manager can cancel')
  }

  // ── Coach claim (open) / targeted accept → awaiting_approval ──
  if (requestedStatus === 'awaiting_approval') {
    if (swap.status !== 'pending') return deny(409, 'Swap is not open for accepting')
    if (isRequester) return deny(403, 'You cannot accept your own swap')
    if (!atLocation) return deny(403, 'Not at this location')
    if (swap.target_id == null) {
      // open claim
      return { ok: true, status: 200, effect: 'claimed', assignmentOps: [],
        swapUpdates: { status: 'awaiting_approval', target_id: user.id },
        notify: [
          { kind: 'claim_for_requester', to: [swap.requester_id] },
          { kind: 'claim_for_managers' },
        ] }
    }
    if (isTarget) {
      // targeted accept
      return { ok: true, status: 200, effect: 'accepted', assignmentOps: [],
        swapUpdates: { status: 'awaiting_approval', target_id: user.id },
        notify: [
          { kind: 'accept_for_requester', to: [swap.requester_id] },
          { kind: 'accept_for_managers' },
        ] }
    }
    return deny(403, 'This swap is targeted at someone else')
  }

  // ── Withdraw a claim/acceptance → back to open pending ──
  if (requestedStatus === 'pending') {
    if (swap.status !== 'awaiting_approval') return deny(409, 'Nothing to withdraw')
    if (!isTarget) return deny(403, 'Only the taker can withdraw')
    return { ok: true, status: 200, effect: 'withdrawn', assignmentOps: [],
      swapUpdates: { status: 'pending', target_id: null },
      notify: [{ kind: 'withdraw_for_requester', to: [swap.requester_id] }] }
  }

  // ── Reject: target declines (pending) OR manager rejects (any non-terminal) ──
  if (requestedStatus === 'rejected') {
    const ts = nowIso || new Date().toISOString()
    if (isManager) {
      return { ok: true, status: 200, effect: 'rejected', assignmentOps: [],
        swapUpdates: { status: 'rejected', reviewed_by: user.id, reviewed_at: ts, review_note: reviewNote || null },
        notify: [{ kind: 'decision_for_requester', to: [swap.requester_id] }] }
    }
    if (isTarget && swap.status === 'pending') {
      return { ok: true, status: 200, effect: 'declined', assignmentOps: [],
        swapUpdates: { status: 'rejected' },
        notify: [{ kind: 'decline_for_requester', to: [swap.requester_id] }] }
    }
    return deny(403, 'Only the target or a manager can reject')
  }

  // ── Manager approve: finalise on the assignments ──
  if (requestedStatus === 'approved') {
    if (!mayApprove) return deny(403, 'You do not have permission to approve swaps')
    const ts = nowIso || new Date().toISOString()
    const swapUpdates = { status: 'approved', reviewed_by: user.id, reviewed_at: ts, review_note: reviewNote || null }
    if (swap.target_shift_id) {
      const reqProfile = swap.requester_shift?.profile_id
      const tgtProfile = swap.target_shift?.profile_id
      return { ok: true, status: 200, effect: 'approved_swap', swapUpdates,
        assignmentOps: [
          { id: swap.requester_shift_id, set: { profile_id: tgtProfile, status: 'swapped' } },
          { id: swap.target_shift_id, set: { profile_id: reqProfile, status: 'swapped' } },
        ],
        notify: [{ kind: 'decision_for_requester', to: [swap.requester_id] }] }
    }
    if (swap.target_id) {
      return { ok: true, status: 200, effect: 'approved_reassign', swapUpdates,
        assignmentOps: [
          { id: swap.requester_shift_id, set: { profile_id: swap.target_id, status: 'swapped' } },
        ],
        notify: [
          { kind: 'decision_for_requester', to: [swap.requester_id] },
          { kind: 'decision_for_taker', to: [swap.target_id] },
        ] }
    }
    return { ok: true, status: 200, effect: 'approved_drop', swapUpdates,
      assignmentOps: [{ id: swap.requester_shift_id, set: { status: 'cancelled' } }],
      notify: [{ kind: 'decision_for_requester', to: [swap.requester_id] }] }
  }

  return deny(400, 'Unsupported transition')
}
