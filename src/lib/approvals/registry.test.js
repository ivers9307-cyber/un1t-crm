// APPROVALS.1 — registry shape + scoping helpers.
//
// The fetchPending implementations are DB-backed so we don't unit
// test them here; smoke tests in CI catch wiring breaks. The pure
// helpers (user → location scope) get exercised against typical
// shapes so RLS-adjacent regressions are caught early.

import { describe, it, expect } from 'vitest'
import {
  APPROVALS_PROVIDERS,
  userIsMaster,
  ownerLocationIds,
  scheduleApproverLocationIds,
  getPendingApprovalsCount,
  getPendingApprovals,
} from './registry'

describe('APPROVALS_PROVIDERS', () => {
  it('every provider declares the required surface', () => {
    expect(APPROVALS_PROVIDERS.length).toBeGreaterThan(0)
    for (const p of APPROVALS_PROVIDERS) {
      expect(p.key, 'key must be a string').toBeTypeOf('string')
      expect(p.label, 'label must be a string').toBeTypeOf('string')
      expect(p.reviewBase, `${p.key} must have a reviewBase`).toMatch(/^\//)
      expect(typeof p.fetchPending, `${p.key} must export fetchPending`).toBe('function')
      // countPending is optional but recommended for cheap polling.
      if (p.countPending) {
        expect(typeof p.countPending, `${p.key} countPending shape`).toBe('function')
      }
    }
  })

  it('keys are unique', () => {
    const keys = APPROVALS_PROVIDERS.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('userIsMaster', () => {
  it('detects role=master and profileRole=master', () => {
    expect(userIsMaster({ role: 'master' })).toBe(true)
    expect(userIsMaster({ profileRole: 'master' })).toBe(true)
    expect(userIsMaster({ role: 'owner' })).toBe(false)
    expect(userIsMaster(null)).toBe(false)
    expect(userIsMaster(undefined)).toBe(false)
  })
})

describe('ownerLocationIds', () => {
  it('extracts only owner-role locations', () => {
    const user = {
      rolesByLocation: {
        'loc-a': 'owner',
        'loc-b': 'manager',
        'loc-c': 'owner',
        'loc-d': 'staff',
      },
    }
    expect(ownerLocationIds(user).sort()).toEqual(['loc-a', 'loc-c'])
  })

  it('returns empty for users with no locations', () => {
    expect(ownerLocationIds({})).toEqual([])
    expect(ownerLocationIds(null)).toEqual([])
  })
})

describe('scheduleApproverLocationIds', () => {
  it('includes manager / head_coach / owner roles', () => {
    const user = {
      rolesByLocation: {
        'loc-a': 'owner',
        'loc-b': 'manager',
        'loc-c': 'head_coach',
        'loc-d': 'staff',
      },
    }
    const result = scheduleApproverLocationIds(user).sort()
    expect(result).toEqual(['loc-a', 'loc-b', 'loc-c'])
  })

  it('excludes staff', () => {
    const user = { rolesByLocation: { 'loc-only-staff': 'staff' } }
    expect(scheduleApproverLocationIds(user)).toEqual([])
  })
})

describe('getPendingApprovalsCount', () => {
  it('sums across providers, ignoring failures', async () => {
    // Mock a db proxy — each provider calls db.from() but countPending
    // ultimately returns a number, so we stub the chain via a fake
    // builder that resolves to { count, error: null }.
    const ok = (n) => ({
      from() { return this },
      select() { return this },
      eq() { return this },
      in() { return this },
      then(resolve) { return Promise.resolve({ count: n, error: null }).then(resolve) },
    })
    // master sees everything — all four providers run their counts.
    // We can't actually exercise the real countPending without a DB
    // so we shim the function temporarily and confirm sum behaviour.
    const original = APPROVALS_PROVIDERS.map((p) => p.countPending)
    APPROVALS_PROVIDERS.forEach((p, i) => { p.countPending = async () => i + 1 })
    try {
      // Sum 1..N where N = provider count.
      const N = APPROVALS_PROVIDERS.length
      const expected = (N * (N + 1)) / 2
      const total = await getPendingApprovalsCount(ok(0), { role: 'master' })
      expect(total).toBe(expected)
    } finally {
      APPROVALS_PROVIDERS.forEach((p, i) => { p.countPending = original[i] })
    }
  })
})

// APPROVALS-PERCAT.1 — the six category providers now gate on their
// permissionKey (resolved via hasPermission) instead of self-gating
// on ROLE. Uses a minimal stub db — providers whose fetchPending
// needs a query method the stub lacks (.gte/.not/.limit/etc.) will
// throw, but the registry's Promise.allSettled still returns their
// bucket (key present, count 0), which is all these assertions check.
describe('registry per-category gating', () => {
  const db = {
    from() { return this },
    select() { return this },
    eq() { return this },
    in() { return this },
    order() { return this },
    is() { return this },
    then(res) { return Promise.resolve({ data: [], count: 0, error: null }).then(res) },
  }

  function user(role, perms = {}) {
    return {
      role,
      activeLocation: { id: 'loc1', features: {} },
      activeAssignment: { permissions: perms },
      activeRoleTemplate: null,
      rolesByLocation: { loc1: role },
    }
  }

  it('a staff member with no grants sees no approval tabs', async () => {
    const { providers } = await getPendingApprovals(db, user('staff'))
    const keys = providers.map((p) => p.key)
    expect(keys).not.toContain('time_off')
    expect(keys).not.toContain('contractor_invoices')
  })

  it('a staff member granted only time_off sees just the time_off tab (of the six)', async () => {
    const { providers } = await getPendingApprovals(db, user('staff', { approvals_time_off: true }))
    const keys = providers.map((p) => p.key)
    expect(keys).toContain('time_off')
    expect(keys).not.toContain('shift_swaps')
    expect(keys).not.toContain('contractor_invoices')
  })

  it('an owner sees all six category tabs', async () => {
    const { providers } = await getPendingApprovals(db, user('owner'))
    const keys = providers.map((p) => p.key)
    for (const k of ['contractor_invoices', 'fte_expenses', 'agent_requests', 'time_off', 'shift_swaps', 'rosters']) {
      expect(keys).toContain(k)
    }
  })
})
