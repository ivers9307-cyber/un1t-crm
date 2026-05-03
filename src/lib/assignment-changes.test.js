// Tests for assignment-changes — guards + audit writer (mig 080).
//
// Mocks the db chain with vi.fn() spies, mirroring the pattern used in
// activity-events.test.js and deposit-receipts.test.js. Every guard
// branch is exercised because they collectively enforce the
// at-least-one-master invariant — a regression here could leave the
// platform unable to perform admin operations.

import { describe, it, expect, vi } from 'vitest'
import {
  countActiveMasters,
  wouldLeaveZeroMasters,
  logAssignmentChange,
  canRemoveSelfFromLastOwnerLocation,
} from './assignment-changes'

// Builds a vi-spy db that satisfies the chain shapes we use:
//   db.from(table).select(...).eq(...).eq(...).eq(...).neq(...).maybeSingle()
//   db.from(table).select('*').eq('id', x).single()
//   db.from('assignment_change_log').insert({...})
//
// Override the resolved values via the `resolvers` map keyed by table.
function mockDb({ resolvers = {} } = {}) {
  const calls = []
  function makeChain(table) {
    const state = { table, count: undefined, _whereChain: {} }
    const chain = {
      select: vi.fn((cols, opts) => {
        state.count = opts?.count
        return chain
      }),
      insert: vi.fn((row) => {
        calls.push({ table, op: 'insert', row })
        return resolvers[table]?.insert?.(row) ?? Promise.resolve({ data: null, error: null })
      }),
      update: vi.fn(() => chain),
      delete: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      neq: vi.fn(() => chain),
      single: vi.fn(() => resolvers[table]?.single?.() ?? Promise.resolve({ data: null, error: null })),
      maybeSingle: vi.fn(() => resolvers[table]?.maybeSingle?.() ?? Promise.resolve({ data: null, error: null })),
      // For count={ exact: true, head: true } selects.
      then: undefined,
    }
    // The terminal of a count query is the select itself returning a
    // promise-like object. Use a `.then` to make the chain awaitable
    // when the helper code awaits it directly (no .single() etc).
    chain.then = (resolve, reject) => {
      const result = resolvers[table]?.count?.() ?? { data: [], count: 0, error: null }
      Promise.resolve(result).then(resolve, reject)
    }
    return chain
  }
  const db = { from: vi.fn((table) => makeChain(table)) }
  return { db, calls }
}

describe('countActiveMasters', () => {
  it('returns 0 when no masters exist', async () => {
    const { db } = mockDb({
      resolvers: { profiles: { count: () => ({ count: 0, error: null }) } },
    })
    expect(await countActiveMasters(db)).toBe(0)
  })

  it('returns the count from the db', async () => {
    const { db } = mockDb({
      resolvers: { profiles: { count: () => ({ count: 3, error: null }) } },
    })
    expect(await countActiveMasters(db)).toBe(3)
  })

  it('throws on db error', async () => {
    const { db } = mockDb({
      resolvers: { profiles: { count: () => ({ count: null, error: { message: 'boom' } }) } },
    })
    await expect(countActiveMasters(db)).rejects.toThrow(/countActiveMasters failed/)
  })
})

describe('wouldLeaveZeroMasters', () => {
  function setup({ targetRole, targetActive, otherMastersCount }) {
    return mockDb({
      resolvers: {
        profiles: {
          single: () => Promise.resolve({
            data: { role: targetRole, active: targetActive },
            error: null,
          }),
          count: () => ({ count: otherMastersCount, error: null }),
        },
      },
    })
  }

  it('returns wouldLeave=true when target is the only active master', async () => {
    const { db } = setup({ targetRole: 'master', targetActive: true, otherMastersCount: 0 })
    const r = await wouldLeaveZeroMasters(db, 'p1')
    expect(r.wouldLeave).toBe(true)
    expect(r.targetIsActiveMaster).toBe(true)
    expect(r.currentMasters).toBe(1)
  })

  it('returns wouldLeave=false when there are other masters', async () => {
    const { db } = setup({ targetRole: 'master', targetActive: true, otherMastersCount: 2 })
    const r = await wouldLeaveZeroMasters(db, 'p1')
    expect(r.wouldLeave).toBe(false)
    expect(r.currentMasters).toBe(3)
  })

  it('returns wouldLeave=false when target is not a master (no count change)', async () => {
    const { db } = setup({ targetRole: 'staff', targetActive: true, otherMastersCount: 0 })
    const r = await wouldLeaveZeroMasters(db, 'p1')
    expect(r.wouldLeave).toBe(false)
    expect(r.targetIsActiveMaster).toBe(false)
  })

  it('returns wouldLeave=false when target is master but already inactive', async () => {
    const { db } = setup({ targetRole: 'master', targetActive: false, otherMastersCount: 0 })
    const r = await wouldLeaveZeroMasters(db, 'p1')
    expect(r.wouldLeave).toBe(false)
    expect(r.targetIsActiveMaster).toBe(false)
  })
})

describe('logAssignmentChange', () => {
  it('inserts a row with the supplied fields', async () => {
    const { db, calls } = mockDb()
    const r = await logAssignmentChange(db, {
      actorId: 'a1',
      targetProfileId: 't1',
      locationId: 'loc1',
      action: 'assignment_create',
      before: null,
      after: { role: 'staff' },
    })
    expect(r.logged).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe('assignment_change_log')
    expect(calls[0].row).toMatchObject({
      actor_id: 'a1',
      target_profile_id: 't1',
      location_id: 'loc1',
      action: 'assignment_create',
      after: { role: 'staff' },
    })
  })

  it('returns logged=false when missing required fields (does not throw)', async () => {
    const { db, calls } = mockDb()
    const r1 = await logAssignmentChange(db, { actorId: 'a1', targetProfileId: '', action: 'x' })
    const r2 = await logAssignmentChange(db, { actorId: 'a1', targetProfileId: 't1', action: '' })
    expect(r1.logged).toBe(false)
    expect(r2.logged).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('returns logged=false on db error (best-effort, never throws)', async () => {
    const { db } = mockDb({
      resolvers: {
        assignment_change_log: {
          insert: () => Promise.resolve({ data: null, error: { message: 'rls denied' } }),
        },
      },
    })
    const r = await logAssignmentChange(db, {
      actorId: 'a1', targetProfileId: 't1', action: 'master_promote',
    })
    expect(r.logged).toBe(false)
    expect(r.error).toBe('rls denied')
  })

  it('swallows thrown exceptions (best-effort)', async () => {
    const { db } = mockDb({
      resolvers: {
        assignment_change_log: {
          insert: () => Promise.reject(new Error('network')),
        },
      },
    })
    const r = await logAssignmentChange(db, {
      actorId: 'a1', targetProfileId: 't1', action: 'master_promote',
    })
    expect(r.logged).toBe(false)
    expect(r.error).toMatch(/network/)
  })
})

describe('canRemoveSelfFromLastOwnerLocation', () => {
  it('returns wouldOrphan=false when actor is not the target (other-user edit)', async () => {
    const { db } = mockDb()
    const r = await canRemoveSelfFromLastOwnerLocation(db, 'actor', 'other', 'loc')
    expect(r.wouldOrphan).toBe(false)
    expect(r.otherOwnerLocationCount).toBe(-1)
  })

  it('returns wouldOrphan=true when self-edit and no other owner assignments exist', async () => {
    const { db } = mockDb({
      resolvers: { profile_locations: { count: () => ({ count: 0, error: null }) } },
    })
    const r = await canRemoveSelfFromLastOwnerLocation(db, 'me', 'me', 'loc1')
    expect(r.wouldOrphan).toBe(true)
    expect(r.otherOwnerLocationCount).toBe(0)
  })

  it('returns wouldOrphan=false when the user owns at least one other location', async () => {
    const { db } = mockDb({
      resolvers: { profile_locations: { count: () => ({ count: 2, error: null }) } },
    })
    const r = await canRemoveSelfFromLastOwnerLocation(db, 'me', 'me', 'loc1')
    expect(r.wouldOrphan).toBe(false)
    expect(r.otherOwnerLocationCount).toBe(2)
  })

  it('throws on db error (caller fails closed)', async () => {
    const { db } = mockDb({
      resolvers: {
        profile_locations: { count: () => ({ count: null, error: { message: 'rls' } }) },
      },
    })
    await expect(canRemoveSelfFromLastOwnerLocation(db, 'me', 'me', 'loc1')).rejects.toThrow(/canRemove/)
  })
})
