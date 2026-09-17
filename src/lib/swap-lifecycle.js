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

import { timeRangesOverlap, fmtTime } from './schedule-overlap'

export const TERMINAL_SWAP_STATES = ['approved', 'rejected', 'cancelled']

// SWAPS.2 — the columns an approved move clears on every assignment that
// changes hands. They described the PREVIOUS coach's shift: the manager-set
// paid window + its reason (mig 099) and their arrival stamp (mig 609). The
// new coach works the block's times. The route never writes these itself —
// mig 615's approve_* functions do, inside the same transaction as the move —
// so this is the description the assignmentOps carry, pinned against the SQL
// by the migration-615 test.
export const SWAP_MOVE_CLEARS = Object.freeze({
  start_time_override: null,
  end_time_override: null,
  partial_reason: null,
  arrived_at: null,
  arrival_source: null,
})

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
 *   swap.location_id? Gates the manager cancel / manager reject branches, and
 *   the approve default when canApprove is omitted. Omitted = NOT a manager
 *   (fail closed); the bare active-studio role let a manager at one studio
 *   cancel or reject any swap id at another.
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
  // SCHEDROLES.1 — manager AT THE SWAP's studio, answered by the caller
  // (hasRoleAtLocation in the route). Omitted means NOT a manager: fail
  // closed rather than fall back to the active studio's role.
  const isManager = isManagerHere === true
  // APPROVALS-PERCAT.1 — the "approve" transition is gated by the
  // approvals_shift_swaps permission (passed in by the route). Claim /
  // accept / reject-by-target keep using isManager. Default preserves the
  // old behaviour for any caller that doesn't pass canApprove.
  const mayApprove = typeof canApprove === 'boolean' ? canApprove : isManager
  const isRequester = swap.requester_id === user.id
  const isTarget = !!swap.target_id && swap.target_id === user.id

  // SCHEDROLES.2 — the detail-route rule (CLAUDE.md): a swap at a studio the
  // caller has nothing to do with is INVISIBLE, not forbidden, so it answers
  // exactly like an id that does not exist. Every branch below used to refuse
  // a stranger with a 403 whose wording ('Only the requester or a manager can
  // cancel', 'Not at this location', 'Only the taker can withdraw') confirmed
  // the id was real and leaked which transition it was sitting on — an id
  // oracle on a sequentially-probeable resource. Note the test is membership,
  // not authority: a member of the swap's studio who simply isn't allowed to
  // act still gets the honest 403 below, the same split
  // /api/schedule/assignments/[id] and /blocks/[id] use. isManager covers
  // master (hasRoleAtLocation short-circuits for it), and the requester or
  // target can always see their own swap even if they have since left the
  // studio.
  if (!atLocation && !isManager && !isRequester && !isTarget) {
    return deny(404, 'Swap request not found')
  }

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
          { id: swap.requester_shift_id, set: { profile_id: tgtProfile, status: 'swapped', ...SWAP_MOVE_CLEARS } },
          { id: swap.target_shift_id, set: { profile_id: reqProfile, status: 'swapped', ...SWAP_MOVE_CLEARS } },
        ],
        notify: [
          { kind: 'decision_for_requester', to: [swap.requester_id] },
          { kind: 'decision_for_taker', to: [swap.target_id] },
        ] }
    }
    if (swap.target_id) {
      return { ok: true, status: 200, effect: 'approved_reassign', swapUpdates,
        assignmentOps: [
          { id: swap.requester_shift_id, set: { profile_id: swap.target_id, status: 'swapped', ...SWAP_MOVE_CLEARS } },
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

/**
 * SWAPS.2 — which mig 612/615 function approves this effect, and with what.
 * Every approved effect is one RPC now: the swap-row approval and the
 * assignment write (move + clear, or delete) land in one transaction, so a
 * failed write can no longer leave an approved swap with nobody moved.
 *
 * The profile ids passed are the ones the resolver READ; each function
 * refuses with swap_stale if the rows no longer match them.
 *
 * @param {string} effect       resolveSwapTransition(...).effect
 * @param {string} swapId
 * @param {object} swap         swap row with requester_shift / target_shift embeds
 * @param {object} swapUpdates  resolveSwapTransition(...).swapUpdates
 * @returns {{ fn: string, args: object } | null}  null for a non-approval effect
 */
export function swapApprovalRpc(effect, swapId, swap, swapUpdates) {
  if (!swap || !swapUpdates) return null
  const review = {
    p_swap_id: swapId,
    p_reviewed_by: swapUpdates.reviewed_by,
    p_reviewed_at: swapUpdates.reviewed_at,
    p_review_note: swapUpdates.review_note,
  }
  const requester = swap.requester_shift?.profile_id ?? null
  if (effect === 'approved_swap') {
    return { fn: 'approve_reciprocal_shift_swap', args: { ...review, p_requester_profile: requester, p_target_profile: swap.target_shift?.profile_id ?? null } }
  }
  if (effect === 'approved_reassign') {
    return { fn: 'approve_reassign_shift_swap', args: { ...review, p_requester_profile: requester, p_target_profile: swap.target_id ?? null } }
  }
  if (effect === 'approved_drop') {
    return { fn: 'approve_drop_shift_swap', args: { ...review, p_requester_profile: requester } }
  }
  return null
}

// SWAPATOMIC.1 / SWAPS.2 — map an approve_*_shift_swap error to a response.
// Each function raises P0001 with a `swap_*:` message prefix for every state
// it refuses on purpose; those are conflicts with the current data (409) and
// carry a human sentence after the prefix. A unique-key violation (23505) is
// the same kind of conflict. Anything else is an unexpected failure (400, as
// the route has always answered) — and in every case NOTHING was written.
const SWAP_RPC_MESSAGES = {
  swap_not_found: 'Swap request not found',
  swap_not_open: 'This swap has already been decided',
  swap_shift_missing: 'One of the shifts in this swap no longer exists',
  swap_stale: 'This swap has changed since it was loaded: a shift changed hands or someone else claimed it. Refresh and check it again.',
  swap_same_block: 'Both shifts are on the same block, so the swap would change nothing',
  swap_conflict: 'A coach in this swap is already on that shift',
}

export function swapApprovalError(err) {
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

// SWAPS.2 — the response `code` PUT /api/schedule/swaps/[id] sends with a
// 409 when an approval has leave / clash conflicts; a client branches on it
// to offer "approve anyway" (confirm_conflicts: true). A code, not copy: the
// response's `error` carries the human sentences.
export const SWAP_CONFLICTS_CODE = 'swap_conflicts'

// ─────────────────────────────────────────────────────────────────────────
// SWAPS.2 — leave and same-day clash checks for the coach(es) a swap puts
// onto a shift. Advisory at claim/accept (the coach is told, nothing is
// refused); at manager approval the route refuses with 409 unless the
// manager confirms. The DB reads live in src/lib/swap-conflicts.js; the
// decisions and the copy are here so they are testable without a DB.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The coaches a swap puts onto a shift, and which block each lands on.
 *
 *   reassign / claim   the taker lands on the requester's block
 *   reciprocal         the taker lands on the requester's block AND the
 *                      requester lands on the taker's block
 *   drop               nobody lands anywhere -> []
 *
 * `leavingAssignmentId` is the coach's own shift in this swap that they give
 * up, so it can never count as a clash with where they are going.
 *
 * @param {object} swap  swap row with requester_shift / target_shift embeds
 * @param {object} [opts]
 * @param {string|null} [opts.takerId]  who is taking the requester's shift.
 *   The claimant at claim/accept time; defaults to the target shift's coach,
 *   then swap.target_id (the approval view).
 * @param {boolean} [opts.takerOnly]  only the taker's move. At claim time the
 *   claiming coach is shown THEIR conflicts, never a colleague's leave.
 * @returns {Array<{ role:'taker'|'requester', coachId:string, block:object, leavingAssignmentId:string|null }>}
 */
export function swapIncomingMoves(swap, { takerId, takerOnly = false } = {}) {
  if (!swap) return []
  const reqShift = swap.requester_shift || null
  const tgtShift = swap.target_shift || null
  const taker = takerId ?? tgtShift?.profile_id ?? swap.target_id ?? null
  const moves = []
  if (taker && reqShift?.block?.block_date) {
    moves.push({ role: 'taker', coachId: taker, block: reqShift.block, leavingAssignmentId: tgtShift?.id || null })
  }
  if (!takerOnly && swap.target_shift_id && tgtShift?.block?.block_date) {
    const requester = reqShift?.profile_id || swap.requester_id || null
    if (requester) {
      moves.push({ role: 'requester', coachId: requester, block: tgtShift.block, leavingAssignmentId: reqShift?.id || null })
    }
  }
  return moves
}

/**
 * Conflicts for one move, from rows already read. Pure.
 *
 *   leave    an APPROVED time_off_requests row for the coach covers the
 *            block's date. Status and dates are re-checked here rather than
 *            trusted from the query. Any studio: leave is per person.
 *   overlap  another LIVE assignment of the coach's that day whose effective
 *            window (its own override, else its block's times) overlaps the
 *            block's times. The moved row's overrides are cleared by the move
 *            (SWAP_MOVE_CLEARS), so the block's own times are the new coach's
 *            window. The coach's leaving shift and the destination block
 *            itself are excluded (the latter is the RPC's swap_conflict).
 *
 * @param {object} move  one swapIncomingMoves entry
 * @param {object} rows
 * @param {object[]} [rows.timeOff]      time_off_requests rows
 * @param {object[]} [rows.assignments]  shift_assignments rows with a shift_blocks embed
 * @returns {Array<object>}
 */
export function evaluateSwapMoveConflicts(move, { timeOff = [], assignments = [] } = {}) {
  if (!move?.coachId || !move.block?.block_date) return []
  const date = move.block.block_date
  const out = []
  for (const t of timeOff || []) {
    if (t?.profile_id !== move.coachId || t.status !== 'approved') continue
    if (!(t.start_date <= date && t.end_date >= date)) continue
    out.push({ kind: 'leave', role: move.role, coachId: move.coachId, date, type: t.type || null, startDate: t.start_date, endDate: t.end_date })
  }
  for (const a of assignments || []) {
    if (!a || a.profile_id !== move.coachId) continue
    if (a.status === 'cancelled') continue
    if (a.id === move.leavingAssignmentId) continue
    const b = a.shift_blocks
    if (!b || b.block_date !== date) continue
    if (a.block_id === move.block.id || b.id === move.block.id) continue
    const start = a.start_time_override || b.start_time
    const end = a.end_time_override || b.end_time
    if (!timeRangesOverlap(move.block.start_time, move.block.end_time, start, end)) continue
    out.push({
      kind: 'overlap', role: move.role, coachId: move.coachId, date,
      shiftName: b.shift_templates?.name || null,
      locationName: b.locations?.name || null,
      startTime: fmtTime(start),
      endTime: fmtTime(end),
      blockStart: fmtTime(move.block.start_time),
      blockEnd: fmtTime(move.block.end_time),
    })
  }
  return out
}

// time_off_requests.type (mig 283) as it reads after "approved".
const LEAVE_LABELS = {
  holiday: 'holiday',
  sick: 'sick leave',
  unpaid: 'unpaid leave',
  other: 'time off',
  unavailable: 'unavailability',
}

/**
 * One sentence per conflict. `name` is the coach's name; `isViewer` switches
 * to "You" (the claiming coach reading their own warning).
 */
export function swapConflictMessage(conflict, { name, isViewer = false } = {}) {
  const who = isViewer ? 'You' : (name || 'This coach')
  const has = isViewer ? 'have' : 'has'
  const is = isViewer ? 'are' : 'is'
  const whose = isViewer ? 'your' : `${name || 'this coach'}'s`
  if (conflict?.kind === 'leave') {
    const type = LEAVE_LABELS[conflict.type] || 'time off'
    const range = conflict.startDate === conflict.endDate
      ? `on ${conflict.startDate}`
      : `from ${conflict.startDate} to ${conflict.endDate}`
    return `${who} ${has} approved ${type} ${range}, which covers the shift on ${conflict.date}.`
  }
  if (conflict?.kind === 'overlap') {
    const shift = conflict.shiftName || 'another shift'
    const at = conflict.locationName ? ` at ${conflict.locationName}` : ''
    const block = conflict.blockStart && conflict.blockEnd ? ` (${conflict.blockStart} to ${conflict.blockEnd})` : ''
    return `${who} ${is} already on ${shift} ${conflict.startTime} to ${conflict.endTime}${at} on ${conflict.date}, which overlaps the shift${block}.`
  }
  if (conflict?.kind === 'check_failed') {
    return `Could not check ${whose} leave and other shifts for ${conflict.date || 'that day'}.`
  }
  return 'This swap has a conflict.'
}
