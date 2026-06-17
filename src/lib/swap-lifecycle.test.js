// src/lib/swap-lifecycle.test.js
import { describe, it, expect } from 'vitest'
import { resolveSwapTransition, TERMINAL_SWAP_STATES } from './swap-lifecycle'

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
    expect(r.assignmentOps).toEqual([
      { id: 'asg-req', set: { status: 'cancelled' } },
    ])
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
