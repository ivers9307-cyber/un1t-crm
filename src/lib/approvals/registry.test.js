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
  filterRowsByLocationBundle,
} from './registry'
import { CATEGORY_BUNDLES } from '@shared/permission-bundles'

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

// TENANT.8 (item 4) — per-row bundle filter, unit-level. host-events-
// bundle-gate.test.js proves the same behaviour end-to-end through the
// hostEventsProvider; these tests pin the helper's own contract directly
// (batching, fail-open, unmapped category).
describe('filterRowsByLocationBundle', () => {
  function makeLocationsDb(locations) {
    return {
      from(table) {
        expect(table).toBe('locations')
        return {
          select: () => ({
            in: async (_col, ids) => ({ data: locations.filter((l) => ids.includes(l.id)), error: null }),
          }),
        }
      },
    }
  }

  it('keeps a row whose location has the category\'s bundle ON, drops one whose bundle is OFF', async () => {
    const rows = [{ id: 'r1', location_id: 'loc-on' }, { id: 'r2', location_id: 'loc-off' }]
    const db = makeLocationsDb([
      { id: 'loc-on', features: {} },
      { id: 'loc-off', features: { bundle_members: false } },
    ])
    const out = await filterRowsByLocationBundle(db, rows, 'host_events')
    expect(out.map((r) => r.id)).toEqual(['r1'])
  })

  it('makes exactly ONE locations query regardless of row count (batched, not per-row)', async () => {
    const rows = [
      { id: 'r1', location_id: 'loc-a' },
      { id: 'r2', location_id: 'loc-a' },
      { id: 'r3', location_id: 'loc-b' },
    ]
    let calls = 0
    const db = {
      from(table) {
        calls += 1
        expect(table).toBe('locations')
        return { select: () => ({ in: async (_col, ids) => ({ data: ids.map((id) => ({ id, features: {} })), error: null }) }) }
      },
    }
    await filterRowsByLocationBundle(db, rows, 'host_events')
    expect(calls).toBe(1)
  })

  it('fails OPEN (returns all rows unfiltered) when the locations lookup errors', async () => {
    const rows = [{ id: 'r1', location_id: 'loc-a' }]
    const db = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: 'db down' } }) }) }) }
    const out = await filterRowsByLocationBundle(db, rows, 'host_events')
    expect(out).toEqual(rows)
  })

  it('never denies a category with no CATEGORY_BUNDLES mapping (e.g. issues)', async () => {
    const rows = [{ id: 'r1', location_id: 'loc-a' }]
    const db = makeLocationsDb([{ id: 'loc-a', features: { bundle_operations: false, bundle_team: false } }])
    const out = await filterRowsByLocationBundle(db, rows, 'issues')
    expect(out).toEqual(rows)
  })

  it('short-circuits (no query at all) when every row lacks a location_id', async () => {
    const rows = [{ id: 'r1' }, { id: 'r2', location_id: null }]
    const db = { from: () => { throw new Error('should not query') } }
    const out = await filterRowsByLocationBundle(db, rows, 'host_events')
    expect(out).toEqual(rows)
  })

  it('returns an empty array unchanged', async () => {
    const db = { from: () => { throw new Error('should not query') } }
    expect(await filterRowsByLocationBundle(db, [], 'host_events')).toEqual([])
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

// BUNDLES.5 Task 2 — approval categories follow their owning bundle.
//
// CLOSES the parked HOME.3 decision: the per-category permissionKey
// check above (hasPermission) is a pure per-user GRANT — the 8
// approvals_* keys are explicitly EXEMPT from shared/permissions.js's
// own location gate (isFeatureGatedByLocation), so an owner who holds
// the grant used to see the tab regardless of what the location's
// bundles said. These tests prove the registry now applies its OWN,
// independent bundle check on top of the grant, and that the Home
// queue (src/lib/home-queue.js) inherits it for free — it calls these
// exact same getPendingApprovals/getPendingApprovalsCount functions,
// so there is no second gate to patch.
describe('registry per-category gating — bundle layer (BUNDLES.5 Task 2)', () => {
  const db = {
    from() { return this },
    select() { return this },
    eq() { return this },
    in() { return this },
    order() { return this },
    is() { return this },
    then(res) { return Promise.resolve({ data: [], count: 0, error: null }).then(res) },
  }

  function user(role, { perms = {}, features = {} } = {}) {
    return {
      role,
      activeLocation: { id: 'loc1', features },
      activeAssignment: { permissions: perms },
      activeRoleTemplate: null,
      rolesByLocation: { loc1: role },
    }
  }

  it('CATEGORY_BUNDLES covers every provider except the core-exempt "issues" category', () => {
    const categoryKeys = APPROVALS_PROVIDERS.map((p) => p.key)
    const mapped = Object.keys(CATEGORY_BUNDLES)
    expect(mapped.sort()).toEqual(categoryKeys.filter((k) => k !== 'issues').sort())
  })

  it('an owner stops seeing contractor_invoices / fte_expenses / offer_purchases when bundle_money is explicitly off', async () => {
    const { providers } = await getPendingApprovals(db, user('owner', { features: { bundle_money: false } }))
    const keys = providers.map((p) => p.key)
    expect(keys).not.toContain('contractor_invoices')
    expect(keys).not.toContain('fte_expenses')
    expect(keys).not.toContain('offer_purchases')
  })

  it('the same owner sees them again once bundle_money is unset ({}) — back-compat', async () => {
    const { providers } = await getPendingApprovals(db, user('owner', { features: {} }))
    const keys = providers.map((p) => p.key)
    expect(keys).toContain('contractor_invoices')
    expect(keys).toContain('fte_expenses')
  })

  it('a master bookkeeper stops seeing the invoices_queue tab when bundle_money is explicitly off (grant alone used to be enough)', async () => {
    // invoices_queue is isVisible()-gated on the bookkeeper key, not a
    // permissionKey — master qualifies via userIsMaster() with no
    // per-user override needed, isolating this to the bundle check.
    const off = await getPendingApprovals(db, user('master', { features: { bundle_money: false } }))
    expect(off.providers.map((p) => p.key)).not.toContain('invoices_queue')

    const on = await getPendingApprovals(db, user('master', { features: {} }))
    expect(on.providers.map((p) => p.key)).toContain('invoices_queue')
  })

  it('time_off / shift_swaps / rosters follow bundle_team', async () => {
    const off = await getPendingApprovals(db, user('owner', { features: { bundle_team: false } }))
    const offKeys = off.providers.map((p) => p.key)
    expect(offKeys).not.toContain('time_off')
    expect(offKeys).not.toContain('shift_swaps')
    expect(offKeys).not.toContain('rosters')

    const on = await getPendingApprovals(db, user('owner', { features: { bundle_team: true } }))
    const onKeys = on.providers.map((p) => p.key)
    expect(onKeys).toContain('time_off')
    expect(onKeys).toContain('shift_swaps')
    expect(onKeys).toContain('rosters')
  })

  it('hyrox_sessions follows bundle_members', async () => {
    const off = await getPendingApprovals(db, user('owner', { features: { bundle_members: false } }))
    expect(off.providers.map((p) => p.key)).not.toContain('hyrox_sessions')
  })

  it('host_events follows bundle_members', async () => {
    const off = await getPendingApprovals(db, user('owner', { features: { bundle_members: false } }))
    expect(off.providers.map((p) => p.key)).not.toContain('host_events')
  })

  it('agent_requests — OR semantics across its two owning bundles (bundle_sales + bundle_members)', async () => {
    // Only one owning bundle off → still visible.
    const salesOff = await getPendingApprovals(db, user('owner', { features: { bundle_sales: false, bundle_members: true } }))
    expect(salesOff.providers.map((p) => p.key)).toContain('agent_requests')

    const membersOff = await getPendingApprovals(db, user('owner', { features: { bundle_sales: true, bundle_members: false } }))
    expect(membersOff.providers.map((p) => p.key)).toContain('agent_requests')

    // BOTH owning bundles off → denied.
    const bothOff = await getPendingApprovals(db, user('owner', { features: { bundle_sales: false, bundle_members: false } }))
    expect(bothOff.providers.map((p) => p.key)).not.toContain('agent_requests')
  })

  it('the "issues" category is exempt from the bundle layer (core, mirrors issues_inbox) — visible even with every bundle off', async () => {
    const everyBundleOff = {
      bundle_sales: false, bundle_members: false, bundle_money: false,
      bundle_messaging: false, bundle_marketing: false, bundle_team: false,
      bundle_operations: false, module_cars: false,
    }
    const { providers } = await getPendingApprovals(db, user('owner', { features: everyBundleOff }))
    expect(providers.map((p) => p.key)).toContain('issues')
  })

  it('getPendingApprovalsCount applies the same bundle gate as getPendingApprovals (no second, un-patched filter)', async () => {
    // Shim contractor_invoices' countPending so the total is
    // observable — the stub db always resolves count:0, so without
    // this the assertion would be vacuously true regardless of
    // whether the fix actually applies to the count path too.
    const provider = APPROVALS_PROVIDERS.find((p) => p.key === 'contractor_invoices')
    const original = provider.countPending
    provider.countPending = async () => 5
    try {
      const withMoney = await getPendingApprovalsCount(db, user('owner', { features: {} }))
      const withoutMoney = await getPendingApprovalsCount(db, user('owner', { features: { bundle_money: false } }))
      expect(withMoney).toBeGreaterThanOrEqual(5)
      expect(withoutMoney).toBe(withMoney - 5)
    } finally {
      provider.countPending = original
    }
  })
})
