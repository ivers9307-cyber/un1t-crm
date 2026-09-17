// src/lib/swap-lifecycle.test.js
import { describe, it, expect } from 'vitest'
import { resolveSwapTransition, TERMINAL_SWAP_STATES, swapChangeLogEntries } from './swap-lifecycle'

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

  it('rejects a claim by a coach not at the swap location', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'awaiting_approval',
      user: coach('coach-2'),
      userLocationIds: ['loc-other'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
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
      userLocationIds: ['loc-1'],
      reviewNote: 'ok',
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('approved_reassign')
    expect(r.swapUpdates).toMatchObject({ status: 'approved', reviewed_by: 'mgr-1', review_note: 'ok' })
    expect(r.swapUpdates.reviewed_at).toBeTruthy()
    expect(r.assignmentOps).toEqual([
      { id: 'asg-req', set: { profile_id: 'coach-2', status: 'swapped' } },
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
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('approved_swap')
    expect(r.assignmentOps).toEqual(
      expect.arrayContaining([
        { id: 'asg-req', set: { profile_id: 'coach-2', status: 'swapped' } },
        { id: 'asg-tgt', set: { profile_id: 'req-1', status: 'swapped' } },
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
// canApprove defaults to the old isManager check when omitted, so every
// existing caller/test above (which never passes it) keeps working.
describe('resolveSwapTransition canApprove override', () => {
  it('denies a manager approval when canApprove is explicitly false', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'approved',
      user: manager,
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

  it('falls back to the manager check when canApprove is omitted (back-compat)', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'approved',
      user: manager,
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('approved_reassign')
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
      swap, requestedStatus: 'approved', user: manager, userLocationIds: ['loc-1'],
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
