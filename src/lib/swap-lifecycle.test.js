// src/lib/swap-lifecycle.test.js
import { describe, it, expect } from 'vitest'
import {
  resolveSwapTransition, TERMINAL_SWAP_STATES, swapChangeLogEntries, swapApprovalError, swapApprovalRpc,
  swapIncomingMoves, evaluateSwapMoveConflicts, swapConflictMessage, SWAP_MOVE_CLEARS, SHIFT_STARTED_ERROR,
} from './swap-lifecycle'

// Minimal swap factory. requester_shift / target_shift mirror the embed the
// route fetches (only profile_id is read by the resolver).
function makeSwap(over = {}) {
  return {
    id: 'swap-1',
    location_id: 'loc-1',
    status: 'pending',
    requester_id: 'req-1',
    target_id: null,
    requester_shift_id: 'asg-req',
    target_shift_id: null,
    requester_shift: { id: 'asg-req', profile_id: 'req-1' },
    target_shift: null,
    ...over,
  }
}
const manager = { id: 'mgr-1', role: 'manager' }
const coach = (id) => ({ id, role: 'staff' })

describe('resolveSwapTransition — coach claim (open swap)', () => {
  it('lets an eligible coach claim an open pending swap', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'awaiting_approval',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('claimed')
    expect(r.swapUpdates).toMatchObject({ status: 'awaiting_approval', target_id: 'coach-2' })
    expect(r.assignmentOps).toEqual([])
    expect(r.notify).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'claim_for_requester', to: ['req-1'] }),
        expect.objectContaining({ kind: 'claim_for_managers' }),
      ])
    )
  })

  it('rejects a claim by the requester themselves', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'awaiting_approval',
      user: coach('req-1'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })

  // SCHEDROLES.2 — a stranger to the swap's studio gets the detail-route 404,
  // not a 403 that confirms the id exists.
  it('404s a claim by a coach not at the swap location', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'awaiting_approval',
      user: coach('coach-2'),
      userLocationIds: ['loc-other'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
    expect(r.error).toBe('Swap request not found')
  })

  it('rejects claiming a swap already targeted at someone else', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ target_id: 'coach-9' }),
      requestedStatus: 'awaiting_approval',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })
})

describe('resolveSwapTransition — targeted accept/decline', () => {
  it('lets the target accept a targeted pending swap', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ target_id: 'coach-2' }),
      requestedStatus: 'awaiting_approval',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('accepted')
    expect(r.swapUpdates).toMatchObject({ status: 'awaiting_approval', target_id: 'coach-2' })
  })

  it('lets the target decline a targeted pending swap', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ target_id: 'coach-2' }),
      requestedStatus: 'rejected',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('declined')
    expect(r.swapUpdates).toMatchObject({ status: 'rejected' })
    expect(r.assignmentOps).toEqual([])
  })

  it('rejects an accept by a non-target coach', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ target_id: 'coach-2' }),
      requestedStatus: 'awaiting_approval',
      user: coach('coach-3'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })
})

describe('resolveSwapTransition — withdraw', () => {
  it('lets the taker withdraw, re-opening to the pool', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'pending',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('withdrawn')
    expect(r.swapUpdates).toMatchObject({ status: 'pending', target_id: null })
  })

  it('rejects withdraw by someone who is not the taker', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'pending',
      user: coach('coach-3'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })
})

describe('resolveSwapTransition — requester cancel', () => {
  it('lets the requester cancel their own pending swap', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'cancelled',
      user: coach('req-1'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('cancelled')
    expect(r.swapUpdates).toMatchObject({ status: 'cancelled' })
  })

  it('lets the requester cancel a claimed (awaiting_approval) swap', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'cancelled',
      user: coach('req-1'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
  })

  it('rejects cancel by a non-requester non-manager', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'cancelled',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })
})

describe('resolveSwapTransition — manager approve finalisation', () => {
  it('reassigns the requester shift to the taker on claim approval (target_id, no target_shift_id)', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'approved',
      user: manager,
      isManagerHere: true,
      userLocationIds: ['loc-1'],
      reviewNote: 'ok',
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('approved_reassign')
    expect(r.swapUpdates).toMatchObject({ status: 'approved', reviewed_by: 'mgr-1', review_note: 'ok' })
    expect(r.swapUpdates.reviewed_at).toBeTruthy()
    expect(r.assignmentOps).toEqual([
      { id: 'asg-req', set: { profile_id: 'coach-2', status: 'swapped', ...SWAP_MOVE_CLEARS } },
    ])
  })

  it('does a reciprocal swap when target_shift_id is set', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({
        status: 'awaiting_approval',
        target_id: 'coach-2',
        target_shift_id: 'asg-tgt',
        requester_shift: { id: 'asg-req', profile_id: 'req-1' },
        target_shift: { id: 'asg-tgt', profile_id: 'coach-2' },
      }),
      requestedStatus: 'approved',
      user: manager,
      isManagerHere: true,
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('approved_swap')
    expect(r.assignmentOps).toEqual(
      expect.arrayContaining([
        { id: 'asg-req', set: { profile_id: 'coach-2', status: 'swapped', ...SWAP_MOVE_CLEARS } },
        { id: 'asg-tgt', set: { profile_id: 'req-1', status: 'swapped', ...SWAP_MOVE_CLEARS } },
      ])
    )
    // SWAPNOTIFY.1 — a reciprocal swap changes BOTH coaches' shifts; before
    // this the target (swap.target_id) was never told their shift changed.
    expect(r.notify).toEqual(
      expect.arrayContaining([
        { kind: 'decision_for_requester', to: ['req-1'] },
        { kind: 'decision_for_taker', to: ['coach-2'] },
      ])
    )
    expect(r.notify).toHaveLength(2)
  })

  it('drops the shift when approving an untargeted swap', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'approved',
      user: manager,
      isManagerHere: true,
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('approved_drop')
    // ROSTER-FIX.1 (D4) — DELETE, not a `cancelled` tombstone.
    expect(r.assignmentOps).toEqual([{ id: 'asg-req', delete: true }])
  })

  it('lets a manager reject without touching assignments', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'rejected',
      user: manager,
      isManagerHere: true,
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('rejected')
    expect(r.assignmentOps).toEqual([])
    expect(r.swapUpdates).toMatchObject({ status: 'rejected', reviewed_by: 'mgr-1' })
  })

  it('rejects a non-manager trying to approve', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'approved',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })
})

describe('resolveSwapTransition — terminal-state + bad-input guards', () => {
  it.each(['approved', 'rejected', 'cancelled'])('rejects any action on a %s swap', (st) => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: st }),
      requestedStatus: 'awaiting_approval',
      user: manager,
      isManagerHere: true,
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(409)
  })

  it('rejects an unknown requestedStatus', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'banana',
      user: manager,
      isManagerHere: true,
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
  })

  it('exports the terminal set', () => {
    expect(TERMINAL_SWAP_STATES).toEqual(expect.arrayContaining(['approved', 'rejected', 'cancelled']))
  })
})

// APPROVALS-PERCAT.1 — the "approve" transition is gated by the
// approvals_shift_swaps permission, passed in as `canApprove` by the route.
// canApprove defaults to the isManagerHere answer when omitted.
describe('resolveSwapTransition canApprove override', () => {
  it('denies a manager approval when canApprove is explicitly false', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'approved',
      user: manager,
      isManagerHere: true,
      userLocationIds: ['loc-1'],
      canApprove: false,
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })

  it('allows a non-manager to approve when canApprove is explicitly true', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'approved',
      user: coach('coach-9'),
      userLocationIds: ['loc-1'],
      canApprove: true,
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('approved_reassign')
  })

  it('falls back to isManagerHere when canApprove is omitted', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'approved',
      user: manager,
      isManagerHere: true,
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('approved_reassign')
  })

  it('SCHEDROLES.1 — with neither canApprove nor isManagerHere, even a manager is refused (fail closed)', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'approved',
      user: manager,
      userLocationIds: ['loc-1'],
    })
    expect(r.status).toBe(403)
  })
})

// GUARD: every status the resolver writes onto shift_assignments must be a
// value the DB CHECK constraint permits (mig 067 + mig 337). A pure test can't
// touch the constraint, so this asserts against a hard-coded copy of the
// allowed set — keep the two in lockstep. This is the drift that caused
// "shift_assignments_status_check" 500s on approval (status='swapped' was
// emitted before mig 337 allowed it).
describe('resolveSwapTransition — assignment status stays DB-valid', () => {
  // Must match the CHECK on public.shift_assignments.status.
  const VALID_ASSIGNMENT_STATUSES = ['scheduled', 'confirmed', 'completed', 'cancelled', 'swapped']

  const approveCases = [
    ['reciprocal swap', makeSwap({
      status: 'awaiting_approval', target_id: 'coach-2',
      target_shift_id: 'asg-tgt', target_shift: { id: 'asg-tgt', profile_id: 'coach-2' },
    })],
    ['reassign (open claim)', makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' })],
    ['drop (no taker)', makeSwap({ status: 'awaiting_approval' })],
  ]

  it.each(approveCases)('%s → only DB-valid assignment statuses', (_label, swap) => {
    const r = resolveSwapTransition({
      swap, requestedStatus: 'approved', user: manager, userLocationIds: ['loc-1'], isManagerHere: true,
    })
    expect(r.ok).toBe(true)
    for (const op of r.assignmentOps) {
      // ROSTER-FIX.1 (D4) — a drop is a delete op; it carries no `set`.
      if (op.delete) continue
      if (op.set.status !== undefined) {
        expect(VALID_ASSIGNMENT_STATUSES).toContain(op.set.status)
      }
    }
  })
})

describe('swapChangeLogEntries (SWAPAUDIT.1)', () => {
  const reqBlock = { id: 'blk-req', location_id: 'loc-1', block_date: '2099-01-01', rosters: { status: 'published' } }
  const tgtBlock = { id: 'blk-tgt', location_id: 'loc-1', block_date: '2099-01-02', rosters: { status: 'draft' } }

  it('reassign: requester leaves, taker takes, both on the requester block', () => {
    const swap = makeSwap({ target_id: 'coach-2', requester_shift: { id: 'asg-req', profile_id: 'req-1', block_id: 'blk-req', block: reqBlock } })
    expect(swapChangeLogEntries('approved_reassign', swap)).toEqual([
      { role: 'requester', coachId: 'req-1', action: 'unassigned', block: reqBlock, blockId: 'blk-req' },
      { role: 'taker', coachId: 'coach-2', action: 'assigned', block: reqBlock, blockId: 'blk-req' },
    ])
  })

  it('reciprocal: four rows, each block gets a leave and a take', () => {
    const swap = makeSwap({
      target_id: 'coach-2',
      target_shift_id: 'asg-tgt',
      requester_shift: { id: 'asg-req', profile_id: 'req-1', block_id: 'blk-req', block: reqBlock },
      target_shift: { id: 'asg-tgt', profile_id: 'coach-2', block_id: 'blk-tgt', block: tgtBlock },
    })
    expect(swapChangeLogEntries('approved_swap', swap)).toEqual([
      { role: 'requester', coachId: 'req-1', action: 'unassigned', block: reqBlock, blockId: 'blk-req' },
      { role: 'taker', coachId: 'coach-2', action: 'assigned', block: reqBlock, blockId: 'blk-req' },
      { role: 'taker', coachId: 'coach-2', action: 'unassigned', block: tgtBlock, blockId: 'blk-tgt' },
      { role: 'requester', coachId: 'req-1', action: 'assigned', block: tgtBlock, blockId: 'blk-tgt' },
    ])
  })

  it('falls back to the embed block_id when the block embed is missing', () => {
    const swap = makeSwap({ target_id: 'coach-2', requester_shift: { id: 'asg-req', profile_id: 'req-1', block_id: 'blk-req' } })
    const entries = swapChangeLogEntries('approved_reassign', swap)
    expect(entries.map((e) => [e.block, e.blockId])).toEqual([[null, 'blk-req'], [null, 'blk-req']])
  })

  it('returns nothing for any other effect', () => {
    for (const effect of ['approved_drop', 'rejected', 'claimed', 'cancelled', 'denied']) {
      expect(swapChangeLogEntries(effect, makeSwap({ target_id: 'coach-2' }))).toEqual([])
    }
    expect(swapChangeLogEntries('approved_swap', null)).toEqual([])
  })
})

describe('swapApprovalError (SWAPATOMIC.1 / SWAPS.2)', () => {
  it('maps each swap_* refusal to a 409 with a human message', () => {
    for (const prefix of ['swap_not_open', 'swap_shift_missing', 'swap_stale', 'swap_same_block', 'swap_conflict']) {
      const r = swapApprovalError({ code: 'P0001', message: `${prefix}: detail` })
      expect(r.status).toBe(409)
      expect(r.error).not.toMatch(/^swap_/)
    }
  })
  it('maps swap_not_found to 404', () => {
    expect(swapApprovalError({ code: 'P0001', message: 'swap_not_found: x' })).toEqual({ status: 404, error: 'Swap request not found' })
  })
  it('maps a unique violation to a 409 conflict', () => {
    expect(swapApprovalError({ code: '23505', message: 'duplicate key' }).status).toBe(409)
  })
  it('leaves an unrecognised P0001 or any other error as a 400 with the raw message', () => {
    expect(swapApprovalError({ code: 'P0001', message: 'something else' })).toEqual({ status: 400, error: 'something else' })
    expect(swapApprovalError({ code: '08006', message: 'connection lost' })).toEqual({ status: 400, error: 'connection lost' })
    expect(swapApprovalError(null)).toEqual({ status: 400, error: 'Swap failed' })
  })
})

describe('SWAP_MOVE_CLEARS (SWAPS.2)', () => {
  it('clears the previous coach\'s overrides, reason and arrival stamp, nothing else', () => {
    expect(SWAP_MOVE_CLEARS).toEqual({
      start_time_override: null, end_time_override: null, partial_reason: null, arrived_at: null, arrival_source: null,
    })
    expect(Object.isFrozen(SWAP_MOVE_CLEARS)).toBe(true)
  })
})

describe('swapApprovalRpc (SWAPS.2)', () => {
  const updates = { status: 'approved', reviewed_by: 'mgr-1', reviewed_at: '2026-09-17T10:00:00Z', review_note: 'ok' }
  const review = { p_swap_id: 'swap-1', p_reviewed_by: 'mgr-1', p_reviewed_at: '2026-09-17T10:00:00Z', p_review_note: 'ok' }

  it('reciprocal -> approve_reciprocal_shift_swap with both coaches read off the embeds', () => {
    const swap = makeSwap({ target_id: 'coach-2', target_shift_id: 'asg-tgt', target_shift: { id: 'asg-tgt', profile_id: 'coach-2' } })
    expect(swapApprovalRpc('approved_swap', 'swap-1', swap, updates)).toEqual({
      fn: 'approve_reciprocal_shift_swap', args: { ...review, p_requester_profile: 'req-1', p_target_profile: 'coach-2' },
    })
  })

  it('reassign -> approve_reassign_shift_swap with the taker from swap.target_id', () => {
    const swap = makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' })
    expect(swapApprovalRpc('approved_reassign', 'swap-1', swap, updates)).toEqual({
      fn: 'approve_reassign_shift_swap', args: { ...review, p_requester_profile: 'req-1', p_target_profile: 'coach-2' },
    })
  })

  it('drop -> approve_drop_shift_swap with the requester only', () => {
    expect(swapApprovalRpc('approved_drop', 'swap-1', makeSwap(), updates)).toEqual({
      fn: 'approve_drop_shift_swap', args: { ...review, p_requester_profile: 'req-1' },
    })
  })

  it('passes null profiles when the embed is missing (the function answers swap_stale)', () => {
    const swap = makeSwap({ requester_shift: null })
    expect(swapApprovalRpc('approved_drop', 'swap-1', swap, updates).args.p_requester_profile).toBeNull()
  })

  it('returns null for every non-approval effect', () => {
    for (const effect of ['claimed', 'accepted', 'withdrawn', 'declined', 'rejected', 'cancelled', 'denied']) {
      expect(swapApprovalRpc(effect, 'swap-1', makeSwap(), updates)).toBeNull()
    }
    expect(swapApprovalRpc('approved_drop', 'swap-1', null, updates)).toBeNull()
  })
})

describe('swapIncomingMoves (SWAPS.2)', () => {
  const reqBlock = { id: 'blk-req', block_date: '2099-01-01', start_time: '06:00:00', end_time: '10:00:00' }
  const tgtBlock = { id: 'blk-tgt', block_date: '2099-01-02', start_time: '17:00:00', end_time: '20:00:00' }
  const reciprocalSwap = () => makeSwap({
    target_id: 'coach-2', target_shift_id: 'asg-tgt',
    requester_shift: { id: 'asg-req', profile_id: 'req-1', block: reqBlock },
    target_shift: { id: 'asg-tgt', profile_id: 'coach-2', block: tgtBlock },
  })

  it('reassign: the taker lands on the requester block, leaving nothing', () => {
    const swap = makeSwap({ target_id: 'coach-2', requester_shift: { id: 'asg-req', profile_id: 'req-1', block: reqBlock } })
    expect(swapIncomingMoves(swap)).toEqual([
      { role: 'taker', coachId: 'coach-2', block: reqBlock, leavingAssignmentId: null },
    ])
  })

  it('open claim: the claimant is the taker', () => {
    const swap = makeSwap({ requester_shift: { id: 'asg-req', profile_id: 'req-1', block: reqBlock } })
    expect(swapIncomingMoves(swap, { takerId: 'coach-9', takerOnly: true })).toEqual([
      { role: 'taker', coachId: 'coach-9', block: reqBlock, leavingAssignmentId: null },
    ])
  })

  it('reciprocal: both coaches land on the other block, each leaving their own shift', () => {
    expect(swapIncomingMoves(reciprocalSwap())).toEqual([
      { role: 'taker', coachId: 'coach-2', block: reqBlock, leavingAssignmentId: 'asg-tgt' },
      { role: 'requester', coachId: 'req-1', block: tgtBlock, leavingAssignmentId: 'asg-req' },
    ])
  })

  it('takerOnly keeps a colleague\'s move (and leave) out of a claim', () => {
    expect(swapIncomingMoves(reciprocalSwap(), { takerId: 'coach-2', takerOnly: true }).map((m) => m.role)).toEqual(['taker'])
  })

  it('drop, missing swap or missing block embed: no moves', () => {
    expect(swapIncomingMoves(makeSwap({ requester_shift: { id: 'asg-req', profile_id: 'req-1', block: reqBlock } }))).toEqual([])
    expect(swapIncomingMoves(null)).toEqual([])
    expect(swapIncomingMoves(makeSwap({ target_id: 'coach-2' }))).toEqual([])
  })
})

describe('evaluateSwapMoveConflicts (SWAPS.2)', () => {
  const block = { id: 'blk-1', block_date: '2099-01-01', start_time: '06:00:00', end_time: '10:00:00' }
  const move = { role: 'taker', coachId: 'coach-2', block, leavingAssignmentId: 'asg-own' }
  const other = (over = {}) => ({
    id: 'asg-x', profile_id: 'coach-2', block_id: 'blk-x', status: 'scheduled',
    shift_blocks: { id: 'blk-x', block_date: '2099-01-01', start_time: '09:00:00', end_time: '12:00:00', shift_templates: { name: 'Midday' }, locations: { name: 'Hatch' } },
    ...over,
  })
  const leave = (over = {}) => ({ id: 't1', profile_id: 'coach-2', type: 'holiday', status: 'approved', start_date: '2098-12-31', end_date: '2099-01-02', ...over })

  it('approved leave covering the date is a conflict', () => {
    expect(evaluateSwapMoveConflicts(move, { timeOff: [leave()] })).toEqual([
      { kind: 'leave', role: 'taker', coachId: 'coach-2', date: '2099-01-01', type: 'holiday', startDate: '2098-12-31', endDate: '2099-01-02' },
    ])
  })

  it('pending leave, leave not covering the date, or someone else\'s leave is not', () => {
    expect(evaluateSwapMoveConflicts(move, { timeOff: [
      leave({ status: 'pending' }),
      leave({ start_date: '2099-01-02', end_date: '2099-01-03' }),
      leave({ profile_id: 'coach-3' }),
    ] })).toEqual([])
  })

  it('an overlapping live shift that day is a conflict, with its effective window', () => {
    expect(evaluateSwapMoveConflicts(move, { assignments: [other()] })).toEqual([{
      kind: 'overlap', role: 'taker', coachId: 'coach-2', date: '2099-01-01',
      shiftName: 'Midday', locationName: 'Hatch', startTime: '09:00', endTime: '12:00', blockStart: '06:00', blockEnd: '10:00',
    }])
  })

  it('uses the other shift\'s own override: trimmed clear of the block, no conflict', () => {
    expect(evaluateSwapMoveConflicts(move, { assignments: [other({ start_time_override: '10:00:00' })] })).toEqual([])
  })

  it('ignores touching shifts, cancelled rows, the leaving shift, the destination block and other days', () => {
    const touching = other({ shift_blocks: { ...other().shift_blocks, start_time: '10:00:00' } })
    expect(evaluateSwapMoveConflicts(move, { assignments: [
      touching,
      other({ status: 'cancelled' }),
      other({ id: 'asg-own' }),
      other({ block_id: 'blk-1', shift_blocks: { ...other().shift_blocks, id: 'blk-1' } }),
      other({ shift_blocks: { ...other().shift_blocks, block_date: '2099-01-02' } }),
      other({ profile_id: 'coach-3' }),
    ] })).toEqual([])
  })

  it('no coach or no date: nothing', () => {
    expect(evaluateSwapMoveConflicts({ ...move, coachId: null }, { timeOff: [leave()] })).toEqual([])
    expect(evaluateSwapMoveConflicts(null)).toEqual([])
  })
})

describe('swapConflictMessage (SWAPS.2)', () => {
  const leave = { kind: 'leave', coachId: 'c', date: '2099-01-01', type: 'holiday', startDate: '2099-01-01', endDate: '2099-01-03' }
  const overlap = { kind: 'overlap', coachId: 'c', date: '2099-01-01', shiftName: 'Midday', locationName: 'Hatch', startTime: '09:00', endTime: '12:00', blockStart: '06:00', blockEnd: '10:00' }

  it('names a colleague for a manager', () => {
    expect(swapConflictMessage(leave, { name: 'Bea' })).toBe('Bea has approved holiday from 2099-01-01 to 2099-01-03, which covers the shift on 2099-01-01.')
    expect(swapConflictMessage(overlap, { name: 'Bea' })).toBe('Bea is already on Midday 09:00 to 12:00 at Hatch on 2099-01-01, which overlaps the shift (06:00 to 10:00).')
  })

  it('speaks to the coach as "You"', () => {
    expect(swapConflictMessage({ ...leave, endDate: '2099-01-01', type: 'sick' }, { isViewer: true })).toBe('You have approved sick leave on 2099-01-01, which covers the shift on 2099-01-01.')
    expect(swapConflictMessage(overlap, { isViewer: true })).toMatch(/^You are already on Midday/)
  })

  it('falls back when names or details are missing', () => {
    expect(swapConflictMessage({ ...overlap, shiftName: null, locationName: null })).toMatch(/^This coach is already on another shift 09:00 to 12:00 on/)
    expect(swapConflictMessage({ kind: 'check_failed', date: '2099-01-01' }, { name: 'Bea' })).toBe('Could not check Bea\'s leave and other shifts for 2099-01-01.')
  })

  it('never uses an em dash', () => {
    for (const c of [leave, overlap, { kind: 'check_failed' }]) {
      expect(swapConflictMessage(c, { name: 'Bea' })).not.toMatch(/—/)
    }
  })
})

// SCHEDROLES.1 — the manager cancel / reject branches are judged at the
// swap's studio. The route passes `isManagerHere`; omitted means not a
// manager.
describe('resolveSwapTransition — manager branches are per studio (SCHEDROLES.1)', () => {
  it('isManagerHere=false refuses a manager-at-another-studio cancel and reject', () => {
    for (const requestedStatus of ['cancelled', 'rejected']) {
      const r = resolveSwapTransition({
        swap: makeSwap(), requestedStatus, user: manager, userLocationIds: ['loc-1'], isManagerHere: false,
      })
      expect(r.ok).toBe(false)
      expect(r.status).toBe(403)
    }
  })

  it('isManagerHere=true allows them, whatever the active-studio role says', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(), requestedStatus: 'rejected', user: coach('mix'), userLocationIds: ['loc-1'], isManagerHere: true,
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('rejected')
  })

  it('without isManagerHere, even an active-studio manager AT the swap\'s studio is refused (fail closed)', () => {
    for (const requestedStatus of ['cancelled', 'rejected']) {
      const r = resolveSwapTransition({
        swap: makeSwap(), requestedStatus, user: manager, userLocationIds: ['loc-1'],
      })
      expect(r.status).toBe(403)
    }
  })

  it('the requester still cancels their own swap with isManagerHere=false', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(), requestedStatus: 'cancelled', user: coach('req-1'), userLocationIds: ['loc-1'], isManagerHere: false,
    })
    expect(r.ok).toBe(true)
  })
})

// SCHEDSTATUS.1 / SCHEDROLES.2 — the detail-route rule, applied to every
// transition rather than to the one branch that happened to check membership.
describe('resolveSwapTransition — a foreign swap id is invisible, not forbidden', () => {
  const stranger = { id: 'nobody', role: 'staff' }
  const foreign = ['loc-other']

  for (const requestedStatus of ['cancelled', 'awaiting_approval', 'pending', 'rejected', 'approved']) {
    it(`404s '${requestedStatus}' from a caller outside the swap's studio`, () => {
      const r = resolveSwapTransition({
        swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
        requestedStatus,
        user: stranger,
        userLocationIds: foreign,
      })
      expect(r.ok).toBe(false)
      expect(r.status).toBe(404)
      // The message must not vary with the transition, or it is still an oracle.
      expect(r.error).toBe('Swap request not found')
    })
  }

  it('a MEMBER of the studio who may not act still gets an honest 403', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'cancelled',
      user: { id: 'coach-9', role: 'staff' },
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })

  it('the requester keeps access even from another studio', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'cancelled',
      user: { id: 'req-1', role: 'staff' },
      userLocationIds: foreign,
    })
    expect(r.ok).toBe(true)
  })

  it('the target keeps access even from another studio', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'pending',
      user: { id: 'coach-2', role: 'staff' },
      userLocationIds: foreign,
    })
    expect(r.ok).toBe(true)
  })

  it('a manager at the swap\'s studio (isManagerHere) is never 404d', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'cancelled',
      user: { id: 'mgr-1', role: 'manager' },
      userLocationIds: foreign,
      isManagerHere: true,
    })
    expect(r.ok).toBe(true)
  })
})

// COVERLOOP.1 — nothing used to refuse a swap on a shift that is already being
// worked: approving one moves a live shift and clears that coach's arrival
// stamp and overrides (SWAP_MOVE_CLEARS). The route answers `shiftStarted`
// with swapShiftHasStarted (src/lib/swap-cover.js), the predicate the sweep
// closes the swap on. The ways OUT of a swap must keep working.
describe('resolveSwapTransition — a started shift (COVERLOOP.1)', () => {
  const claimed = () => makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' })
  const call = (swap, requestedStatus, user, extra = {}) => resolveSwapTransition({
    swap, requestedStatus, user, userLocationIds: ['loc-1'], shiftStarted: true, ...extra,
  })

  it('the message is exported, once', () => {
    expect(SHIFT_STARTED_ERROR).toBe('This shift has already started')
  })

  it.each([
    ['an open CLAIM', () => call(makeSwap(), 'awaiting_approval', coach('coach-2'))],
    ['a targeted ACCEPT', () => call(makeSwap({ target_id: 'coach-2' }), 'awaiting_approval', coach('coach-2'))],
    ['an APPROVE of a drop', () => call(makeSwap(), 'approved', manager, { isManagerHere: true })],
    ['an APPROVE of a reassign', () => call(claimed(), 'approved', manager, { isManagerHere: true })],
    ['an APPROVE of a reciprocal swap', () => call(makeSwap({ status: 'awaiting_approval', target_id: 'coach-2', target_shift_id: 'asg-tgt', target_shift: { id: 'asg-tgt', profile_id: 'coach-2' } }), 'approved', manager, { isManagerHere: true })],
  ])('refuses %s with 409', (_name, run) => {
    const r = run()
    expect(r).toMatchObject({ ok: false, status: 409, error: 'This shift has already started' })
    expect(r.swapUpdates).toBe(null)
    expect(r.assignmentOps).toEqual([])
  })

  it.each([
    ['the taker WITHDRAWS', () => call(claimed(), 'pending', coach('coach-2')), 'withdrawn'],
    ['the requester CANCELS', () => call(claimed(), 'cancelled', coach('req-1')), 'cancelled'],
    ['a manager CANCELS', () => call(makeSwap(), 'cancelled', manager, { isManagerHere: true }), 'cancelled'],
    ['a manager REJECTS', () => call(claimed(), 'rejected', manager, { isManagerHere: true }), 'rejected'],
    ['the target DECLINES', () => call(makeSwap({ target_id: 'coach-2' }), 'rejected', coach('coach-2')), 'declined'],
  ])('%s still works', (_name, run, effect) => {
    expect(run()).toMatchObject({ ok: true, effect })
  })

  it('does not become an id oracle: a stranger still gets 404, a non-approver still gets 403', () => {
    expect(resolveSwapTransition({ swap: makeSwap(), requestedStatus: 'awaiting_approval', user: coach('x'), userLocationIds: ['loc-9'], shiftStarted: true }))
      .toMatchObject({ ok: false, status: 404 })
    expect(call(makeSwap(), 'approved', coach('coach-2'))).toMatchObject({ ok: false, status: 403 })
    expect(call(makeSwap({ target_id: 'coach-3' }), 'awaiting_approval', coach('coach-2'))).toMatchObject({ ok: false, status: 403 })
  })

  it('omitted or false: nothing changes', () => {
    expect(resolveSwapTransition({ swap: makeSwap(), requestedStatus: 'awaiting_approval', user: coach('coach-2'), userLocationIds: ['loc-1'] })).toMatchObject({ ok: true, effect: 'claimed' })
    expect(resolveSwapTransition({ swap: makeSwap(), requestedStatus: 'awaiting_approval', user: coach('coach-2'), userLocationIds: ['loc-1'], shiftStarted: false })).toMatchObject({ ok: true, effect: 'claimed' })
  })
})
