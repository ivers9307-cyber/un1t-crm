// SUPPORT-ACCESS (Repset Phase 3) — tenant-eye target selection
// (cross-tenant scoping) + the stale-close planner. findOrgSupportTarget
// is the point where a support session for org A must resolve ONLY org-A
// identities — never reach into org B.

import { describe, it, expect, vi } from 'vitest'

// The module imports next/headers + ./supabase at load; neither is called
// by the functions under test, but mock next/headers so the import is inert.
vi.mock('next/headers', () => ({
  cookies: () => ({ get: () => undefined, set: () => {} }),
  headers: () => ({ get: () => null }),
}))

import { findOrgSupportTarget, planStaleSupportCloses } from './support-session.js'

// Minimal chainable fake that applies recorded eq/in filters at resolve.
function makeDb(tables) {
  return {
    from(table) {
      const rows = (tables[table] || []).slice()
      const filters = []
      let limit = null
      const builder = {
        select() { return builder },
        eq(col, val) { filters.push((r) => r[col] === val); return builder },
        in(col, vals) { filters.push((r) => vals.includes(r[col])); return builder },
        order() { return builder },
        limit(n) { limit = n; return builder },
        _apply() {
          let out = rows.filter((r) => filters.every((f) => f(r)))
          if (limit != null) out = out.slice(0, limit)
          return out
        },
        then(resolve, reject) {
          return Promise.resolve({ data: builder._apply(), error: null }).then(resolve, reject)
        },
      }
      return builder
    },
  }
}

const twoOrgFixture = () => ({
  locations: [
    { id: 'LA1', organization_id: 'ORG_A', active: true, name: 'A Studio' },
    { id: 'LB1', organization_id: 'ORG_B', active: true, name: 'B Studio' },
  ],
  profile_organizations: [],
  profile_locations: [
    { profile_id: 'OWNER_A', location_id: 'LA1', role: 'owner', is_default: true },
    { profile_id: 'OWNER_B', location_id: 'LB1', role: 'owner', is_default: true },
  ],
})

describe('findOrgSupportTarget — cross-tenant scoping', () => {
  it('for org A picks an org-A owner + org-A location, NEVER org B', async () => {
    const db = makeDb(twoOrgFixture())
    const t = await findOrgSupportTarget(db, 'ORG_A')
    expect(t.ownerId).toBe('OWNER_A')
    expect(t.locationId).toBe('LA1')
    expect(t.ownerId).not.toBe('OWNER_B')
    expect(t.locationId).not.toBe('LB1')
  })

  it('for org B picks the org-B identity (symmetry)', async () => {
    const db = makeDb(twoOrgFixture())
    const t = await findOrgSupportTarget(db, 'ORG_B')
    expect(t.ownerId).toBe('OWNER_B')
    expect(t.locationId).toBe('LB1')
  })

  it('prefers an org_admin (whole-org owner) over a location owner', async () => {
    const fx = twoOrgFixture()
    fx.profile_organizations = [{ profile_id: 'ADMIN_A', organization_id: 'ORG_A', role: 'org_admin' }]
    const db = makeDb(fx)
    const t = await findOrgSupportTarget(db, 'ORG_A')
    expect(t.ownerId).toBe('ADMIN_A')
    expect(t.locationId).toBe('LA1')
  })

  it('org with NO owner/admin → scope-only (ownerId null, still an org location)', async () => {
    const fx = twoOrgFixture()
    fx.profile_locations = fx.profile_locations.filter((r) => r.location_id !== 'LA1')
    const db = makeDb(fx)
    const t = await findOrgSupportTarget(db, 'ORG_A')
    expect(t.ownerId).toBeNull()
    expect(t.locationId).toBe('LA1')
  })
})

describe('planStaleSupportCloses', () => {
  const HOUR = 60 * 60 * 1000
  it('closes rows older than the max-age with a truthful upper-bound ended_at', () => {
    const now = Date.now()
    const started = new Date(now - 3 * HOUR).toISOString() // 3h old, max-age 2h
    const plan = planStaleSupportCloses([{ id: 'r1', started_at: started }], now)
    expect(plan).toHaveLength(1)
    expect(plan[0].id).toBe('r1')
    // ended_at = started + 2h, NOT now (don't inflate the recorded duration)
    expect(new Date(plan[0].ended_at).getTime()).toBe(new Date(started).getTime() + 2 * HOUR)
  })

  it('leaves fresh rows open', () => {
    const now = Date.now()
    const started = new Date(now - 10 * 60 * 1000).toISOString() // 10 min old
    expect(planStaleSupportCloses([{ id: 'r1', started_at: started }], now)).toHaveLength(0)
  })
})
