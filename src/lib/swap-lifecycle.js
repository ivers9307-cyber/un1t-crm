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
 * @param {boolean} [args.isManagerHere]  SCHEDROLES.1 — is the caller a manager AT
 *   swap.location_id? Gates the manager cancel / manager reject branches. When
 *   omitted it falls back to the active-studio role AND membership of the
 *   swap's studio — never the bare active-studio role, which let a manager at
 *   one studio cancel or reject any swap id at another.
 * @returns {{ ok:boolean, status?:number, error?:string,
 *   swapUpdates:object|null,
 *   assignmentOps:Array<{id:string, set?:object, delete?:boolean}>,
 *   notify:Array<{kind:string,to?:string[]}>, effect:string }}
 */
export function resolveSwapTransition({ swap, requestedStatus, user, userLocationIds, reviewNote = null, nowIso, canApprove, isManagerHere }) {
  if (!swap) return deny(404, 'Swap request not found')
  if (!user) return deny(401, 'Unauthorized')
  if (!REQUESTABLE.includes(requestedStatus)) return deny(400, 'Invalid status')

  const atLocation = Array.isArray(userLocationIds) && userLocationIds.includes(swap.location_id)
  // SCHEDROLES.1 — manager AT THE SWAP's studio. The route passes the
  // per-location answer; the fallback still demands membership of the swap's
  // studio, so the active-studio role alone never reaches a foreign swap.
  const isManager = typeof isManagerHere === 'boolean'
    ? isManagerHere
    : MANAGER_ROLES.includes(user.role) && (user.role === 'master' || atLocation)
  // APPROVALS-PERCAT.1 — the "approve" transition is gated by the
  // approvals_shift_swaps permission (passed in by the route). Claim /
  // accept / reject-by-target keep using isManager. Default preserves the
  // old behaviour for any caller that doesn't pass canApprove.
  const mayApprove = typeof canApprove === 'boolean' ? canApprove : isManager
  const isRequester = swap.requester_id === user.id
  const isTarget = !!swap.target_id && swap.target_id === user.id

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
      // SWAPNOTIFY.1 — a reciprocal swap moves BOTH coaches' shifts, so both
      // have to be told. Before this only the requester (decision_for_requester)
      // was notified; the target (swap.target_id) heard nothing even though
      // their own shift just changed hands too.
      return { ok: true, status: 200, effect: 'approved_swap', swapUpdates,
        assignmentOps: [
          { id: swap.requester_shift_id, set: { profile_id: tgtProfile, status: 'swapped' } },
          { id: swap.target_shift_id, set: { profile_id: reqProfile, status: 'swapped' } },
        ],
        notify: [
          { kind: 'decision_for_requester', to: [swap.requester_id] },
          { kind: 'decision_for_taker', to: [swap.target_id] },
        ] }
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
    // ROSTER-FIX.1 (D4) — a dropped shift is DELETED, not tombstoned. A
    // `cancelled` row kept the block looking staffed, billed the coach's
    // hours, and blocked re-adding them via the (block, profile) unique key.
    return { ok: true, status: 200, effect: 'approved_drop', swapUpdates,
      assignmentOps: [{ id: swap.requester_shift_id, delete: true }],
      notify: [{ kind: 'decision_for_requester', to: [swap.requester_id] }] }
  }

  return deny(400, 'Unsupported transition')
}

/**
 * SWAPAUDIT.1 — the roster_change_log rows an approved reassign / reciprocal
 * swap has to write. Pure: the route turns each entry into a logRosterChange
 * call. Returns [] for every other effect (an approved DROP writes its own
 * row before the delete, because nothing is left to describe afterwards).
 *
 * `role` is which decision notification covers the entry's coach —
 * 'requester' (decision_for_requester) or 'taker' (decision_for_taker) — so
 * the route can stamp a coach's rows only once THAT coach's message
 * delivered. It is keyed by role, not coach id, because the notification goes
 * to swap.requester_id / swap.target_id while the rows carry the assignment's
 * profile_id; the two normally agree but nothing enforces it.
 *
 * `block` is the embedded shift_blocks row (id, location_id, block_date,
 * rosters.status) or null when the embed is missing.
 *
 * @param {string} effect  resolveSwapTransition(...).effect
 * @param {object} swap    swap row with requester_shift / target_shift embeds
 * @returns {Array<{role:'requester'|'taker', coachId:string|null, action:'assigned'|'unassigned', block:object|null, blockId:string|null}>}
 */
export function swapChangeLogEntries(effect, swap) {
  if (!swap) return []
  const reqShift = swap.requester_shift || null
  const reqBlock = reqShift?.block || null
  const reqBlockId = reqBlock?.id || reqShift?.block_id || null
  const requesterCoach = reqShift?.profile_id || swap.requester_id || null

  if (effect === 'approved_reassign') {
    const taker = swap.target_id || null
    return [
      { role: 'requester', coachId: requesterCoach, action: 'unassigned', block: reqBlock, blockId: reqBlockId },
      { role: 'taker', coachId: taker, action: 'assigned', block: reqBlock, blockId: reqBlockId },
    ]
  }

  if (effect === 'approved_swap') {
    const tgtShift = swap.target_shift || null
    const tgtBlock = tgtShift?.block || null
    const tgtBlockId = tgtBlock?.id || tgtShift?.block_id || null
    const takerCoach = tgtShift?.profile_id || swap.target_id || null
    return [
      // The requester's block: the requester left it, the taker took it.
      { role: 'requester', coachId: requesterCoach, action: 'unassigned', block: reqBlock, blockId: reqBlockId },
      { role: 'taker', coachId: takerCoach, action: 'assigned', block: reqBlock, blockId: reqBlockId },
      // The taker's block: the taker left it, the requester took it.
      { role: 'taker', coachId: takerCoach, action: 'unassigned', block: tgtBlock, blockId: tgtBlockId },
      { role: 'requester', coachId: requesterCoach, action: 'assigned', block: tgtBlock, blockId: tgtBlockId },
    ]
  }

  return []
}

// SWAPATOMIC.1 — map an approve_reciprocal_shift_swap error to a response.
// The function raises P0001 with a `swap_*:` message prefix for every state
// it refuses on purpose; those are conflicts with the current data (409) and
// carry a human sentence after the prefix. A unique-key violation (23505) is
// the same kind of conflict. Anything else is an unexpected failure (400, as
// the route has always answered) — and in every case NOTHING was written.
const SWAP_RPC_MESSAGES = {
  swap_not_found: 'Swap request not found',
  swap_not_open: 'This swap has already been decided',
  swap_shift_missing: 'One of the shifts in this swap no longer exists',
  swap_stale: 'One of these shifts has changed hands since the swap was requested',
  swap_same_block: 'Both shifts are on the same block, so the swap would change nothing',
  swap_conflict: 'One of the coaches is already on the other shift',
}

export function reciprocalSwapError(err) {
  const message = err?.message || 'Swap failed'
  const prefix = message.split(':')[0]
  if (err?.code === 'P0001' && SWAP_RPC_MESSAGES[prefix]) {
    return { status: prefix === 'swap_not_found' ? 404 : 409, error: SWAP_RPC_MESSAGES[prefix] }
  }
  if (err?.code === '23505') {
    return { status: 409, error: SWAP_RPC_MESSAGES.swap_conflict }
  }
  return { status: 400, error: message }
}
