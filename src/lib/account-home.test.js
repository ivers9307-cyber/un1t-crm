// REPSET-ACCOUNT.1 — tests for the Account Home roll-up.
//
// Two layers:
//   1. Pure derivation helpers (week window, KPI aggregation, attention
//      rollup, org-scope resolution) — no DB.
//   2. assembleAccountHome against a mocked service-role client — pins
//      that every studio metric is a HEAD-only count / single-row read
//      (no row fetch) and that per-studio failures are isolated.

import { describe, it, expect, vi } from 'vitest'
import {
  dublinWeekWindow,
  aggregateOrgKpis,
  rollupAttention,
  resolveAccountScope,
  assembleAccountHome,
  MEMBER_STATUSES,
} from './account-home.js'

describe('dublinWeekWindow', () => {
  it('is a 7-day inclusive window ending today (Dublin)', () => {
    // 2026-07-20 12:00 UTC — squarely inside a Dublin day.
    const now = Date.parse('2026-07-20T12:00:00Z')
    expect(dublinWeekWindow(now)).toEqual({ start: '2026-07-14', end: '2026-07-20' })
  })

  it('keeps end == start + 6 days across a month boundary', () => {
    const now = Date.parse('2026-08-02T12:00:00Z')
    expect(dublinWeekWindow(now)).toEqual({ start: '2026-07-27', end: '2026-08-02' })
  })
})

describe('aggregateOrgKpis', () => {
  it('sums the per-studio headline numbers', () => {
    const studios = [
      { members: 100, bookings7d: 40, atRiskHigh: 3 },
      { members: 50, bookings7d: 10, atRiskHigh: 1 },
    ]
    expect(aggregateOrgKpis(studios)).toEqual({
      members: 150, bookings7d: 50, atRiskHigh: 4, studioCount: 2,
    })
  })

  it('tolerates missing fields and non-arrays', () => {
    expect(aggregateOrgKpis([{ members: 5 }, {}])).toEqual({
      members: 5, bookings7d: 0, atRiskHigh: 0, studioCount: 2,
    })
    expect(aggregateOrgKpis(null)).toEqual({
      members: 0, bookings7d: 0, atRiskHigh: 0, studioCount: 0,
    })
  })
})

describe('rollupAttention', () => {
  it('surfaces pending approvals ahead of at-risk (an action outranks a watch item)', () => {
    expect(rollupAttention({ openApprovals: 2, atRiskHigh: 5 })).toEqual({
      tone: 'purple', label: '2 to review', needsAttention: true,
    })
  })

  it('surfaces at-risk when there are no approvals', () => {
    expect(rollupAttention({ openApprovals: 0, atRiskHigh: 5 })).toEqual({
      tone: 'amber', label: '5 at risk', needsAttention: true,
    })
  })

  it('is All clear when nothing needs attention', () => {
    expect(rollupAttention({})).toEqual({
      tone: 'teal', label: 'All clear', needsAttention: false,
    })
  })
})

// getOwnerOrganizationIds derives owner orgs from rolesByLocation +
// locations, so build users with that real shape.
function ownerUser(orgId, locId = 'loc-1') {
  return {
    role: 'owner',
    isMaster: false,
    activeOrganization: { id: orgId },
    rolesByLocation: { [locId]: 'owner' },
    locations: [{ id: locId, organization_id: orgId }],
  }
}

describe('resolveAccountScope — org access matrix', () => {
  it('401 when there is no user', () => {
    expect(resolveAccountScope(null, null)).toEqual({ ok: false, status: 401 })
  })

  it('master may target any org via the param', () => {
    const master = { isMaster: true, profileRole: 'master', activeOrganization: { id: 'org-a' } }
    expect(resolveAccountScope(master, 'org-b')).toEqual({ ok: true, orgId: 'org-b', isMaster: true })
  })

  it('master defaults to their active org when no param is given', () => {
    const master = { isMaster: true, profileRole: 'master', activeOrganization: { id: 'org-a' } }
    expect(resolveAccountScope(master, null)).toEqual({ ok: true, orgId: 'org-a', isMaster: true })
  })

  it('owner defaults to (and is allowed) their own org', () => {
    expect(resolveAccountScope(ownerUser('org-a'), null)).toEqual({ ok: true, orgId: 'org-a', isMaster: false })
  })

  it('owner requesting a FOREIGN org gets 404 (not 403 — no existence probe)', () => {
    expect(resolveAccountScope(ownerUser('org-a'), 'org-b')).toEqual({ ok: false, status: 404 })
  })

  it('manager / staff (own no org, not master) → 403', () => {
    const manager = {
      role: 'manager', isMaster: false, activeOrganization: { id: 'org-a' },
      rolesByLocation: { 'loc-1': 'manager' },
      locations: [{ id: 'loc-1', organization_id: 'org-a' }],
    }
    expect(resolveAccountScope(manager, null)).toEqual({ ok: false, status: 403 })
  })
})

// -------------------------------------------------------------------------
// assembleAccountHome against a mocked client. We assert the SHAPE of the
// queries (head-only counts, single-row snapshot) and the assembled output.
// -------------------------------------------------------------------------

// Build a fake supabase client whose per-table behaviour is scripted.
// Every count query returns a thenable resolving { count }, and the
// churn snapshot returns { data }. Records the head-only flag so the
// test can prove we never fetched rows for the counts.
function mockDb(perLocation) {
  const selectCalls = []
  function builder(table, resolver) {
    const filters = {}
    const b = {
      _table: table,
      eq(col, val) { filters[col] = val; return b },
      in(col, val) { filters[`in:${col}`] = val; return b },
      gte(col, val) { filters[`gte:${col}`] = val; return b },
      lte(col, val) { filters[`lte:${col}`] = val; return b },
      neq(col, val) { filters[`neq:${col}`] = val; return b },
      order() { return b },
      limit() { return b },
      then(resolve, reject) {
        return Promise.resolve(resolver(filters)).then(resolve, reject)
      },
    }
    return b
  }
  const db = {
    from(table) {
      return {
        select(cols, opts) {
          selectCalls.push({ table, cols, opts })
          return builder(table, (filters) => {
            const locId = filters.location_id
            const loc = perLocation[locId] || {}
            if (table === 'contacts') return { count: loc.members ?? 0 }
            if (table === 'bookings') return { count: loc.bookings7d ?? 0 }
            if (table === 'time_off_requests') return { count: loc.timeOff ?? 0 }
            if (table === 'invoices_queue') return { count: loc.invoices ?? 0 }
            if (table === 'churn_radar_snapshots') return { data: [{ high_risk: loc.atRiskHigh ?? 0 }] }
            throw new Error(`unexpected table ${table}`)
          })
        },
      }
    },
  }
  return { db, selectCalls }
}

describe('assembleAccountHome', () => {
  const org = { id: 'org-a', name: 'UN1T Group', slug: 'unit' }
  const locations = [
    { id: 'loc-1', name: 'Stillorgan', slug: 'stillorgan', settings: { glofox: { branch_id: 'x' } } },
    { id: 'loc-2', name: 'Hatch', slug: 'hatch', settings: {} },
  ]

  it('rolls up org KPIs and a per-studio breakdown with attention + integration signals', async () => {
    const { db, selectCalls } = mockDb({
      'loc-1': { members: 268, bookings7d: 90, atRiskHigh: 4, timeOff: 1, invoices: 2 },
      'loc-2': { members: 0, bookings7d: 0, atRiskHigh: 0, timeOff: 0, invoices: 0 },
    })
    const now = Date.parse('2026-07-20T12:00:00Z')
    const res = await assembleAccountHome(db, { organization: org, locations, now })

    expect(res.organization).toEqual({ id: 'org-a', name: 'UN1T Group', slug: 'unit' })
    expect(res.kpis).toMatchObject({
      members: 268, bookings7d: 90, atRiskHigh: 4, studioCount: 2,
      weekWindow: { start: '2026-07-14', end: '2026-07-20' },
    })

    const still = res.studios.find((s) => s.id === 'loc-1')
    expect(still).toMatchObject({
      name: 'Stillorgan', members: 268, bookings7d: 90, atRiskHigh: 4,
      openApprovals: 3, integrationConnected: true,
    })
    // 3 open approvals → purple "to review" pill.
    expect(still.attention).toEqual({ tone: 'purple', label: '3 to review', needsAttention: true })

    const hatch = res.studios.find((s) => s.id === 'loc-2')
    expect(hatch).toMatchObject({ integrationConnected: false, openApprovals: 0, atRiskHigh: 0 })
    expect(hatch.attention).toEqual({ tone: 'teal', label: 'All clear', needsAttention: false })

    // Every count query is HEAD-only (no rows transferred → 1000-row cap
    // never engaged). Only the churn snapshot reads a row (LIMIT 1).
    const countTables = ['contacts', 'bookings', 'time_off_requests', 'invoices_queue']
    for (const c of selectCalls.filter((s) => countTables.includes(s.table))) {
      expect(c.opts).toMatchObject({ head: true, count: 'exact' })
    }
    // Members cohort is the Glofox member statuses.
    const contactsCall = selectCalls.find((s) => s.table === 'contacts')
    expect(contactsCall).toBeTruthy()
    expect(MEMBER_STATUSES).toEqual(['member', 'credit_member'])
  })

  it('isolates a per-studio failure to zeros instead of blanking the portfolio', async () => {
    const db = {
      from(table) {
        return {
          select() {
            return {
              eq() { return this },
              in() { return this },
              gte() { return this },
              lte() { return this },
              neq() { return this },
              order() { return this },
              limit() { return this },
              then(_r, reject) { return Promise.reject(new Error('boom')).then(_r, reject) },
            }
          },
        }
      },
    }
    const res = await assembleAccountHome(db, {
      organization: org,
      locations: [locations[0]],
      now: Date.now(),
    })
    expect(res.studios[0]).toMatchObject({
      members: 0, bookings7d: 0, atRiskHigh: 0, openApprovals: 0,
    })
    expect(res.studios[0].attention.tone).toBe('teal')
  })
})
