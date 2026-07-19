// Mocked-pipeline tests for getCurrentUser() — SAAS-4 (mig 411).
//
// The pure expansion semantics live in auth.test.js
// (expandOrgAdminAccess); these tests run the REAL getCurrentUser()
// against a scripted Supabase double + mocked next/headers, pinning
// the two properties that only the full pipeline can prove:
//
//   • MASTER BYTE-IDENTICAL — a master's user object deep-equals the
//     pre-SAAS-4 fixture (the only addition is the new
//     orgAdminOrgIds: [] key), and profile_organizations is NEVER
//     queried for masters.
//   • ROLLOUT SAFETY — a regular user with zero profile_organizations
//     rows produces a user object identical to today's (fixture-
//     pinned), so shipping the code before any grants exist changes
//     nothing for anyone.
//
// Plus the org-admin happy paths: org-bounded location expansion,
// synthetic owner roles, explicit assignment roles preserved, and no
// leakage of another org's locations.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── module doubles ─────────────────────────────────────────────────
// next/headers backs BOTH getCurrentUser's own reads (authorization
// header, active-location header/cookie) and impersonation.js (which
// is imported for real). Empty maps = plain web session, nothing set.
const cookieMap = new Map()
const headerMap = new Map()

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name) => (cookieMap.has(name) ? { value: cookieMap.get(name) } : undefined),
    getAll: () => [],
    set: () => {},
  }),
  headers: async () => ({
    get: (name) => headerMap.get(name.toLowerCase()) ?? null,
  }),
}))

// Cookie-session auth source (createAuthClient). Each test sets
// authUser before calling getCurrentUser().
let authUser = null
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: async () => ({ data: { user: authUser } }) },
  })),
}))

// Service-role client — replaced with the scripted double below.
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }))

import { getCurrentUser, getOwnerOrganizationIds } from './auth.js'
import { createClient } from '@supabase/supabase-js'

// ─── scripted Supabase double ───────────────────────────────────────
// Records every query as { table, calls: [[method, ...args], ...] }
// and resolves it through the scenario responder. Builders are
// thenables (like the real supabase-js) so `await` works anywhere in
// the chain.
function makeDb(respond) {
  const queries = []
  function from(table) {
    const q = { table, calls: [] }
    queries.push(q)
    const builder = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'is', 'single', 'maybeSingle']) {
      builder[m] = (...args) => { q.calls.push([m, ...args]); return builder }
    }
    builder.then = (resolve, reject) => Promise.resolve(respond(q)).then(resolve, reject)
    return builder
  }
  return { db: { from }, queries }
}

const findCall = (q, method) => q.calls.find(c => c[0] === method)

// Scenario responder — routes each table to the scripted data. The
// `locations` table serves BOTH the master all-locations fetch and the
// org-admin `.in('organization_id', ...)` fetch; `organizations`
// serves both the master all-orgs fetch and the non-master
// `.in('id', ...)` member-orgs fetch.
function respondFor(s) {
  return (q) => {
    switch (q.table) {
      case 'profiles':
        return { data: s.profile }
      case 'profile_locations':
        return { data: s.links || [] }
      case 'locations': {
        const inCall = findCall(q, 'in')
        if (inCall) return { data: s.orgLocations || [] }
        return { data: s.allLocations || [] }
      }
      case 'organizations': {
        const inCall = findCall(q, 'in')
        if (inCall) return { data: (s.orgs || []).filter(o => inCall[2].includes(o.id)) }
        return { data: s.orgs || [] }
      }
      case 'profile_organizations':
        return { data: s.orgLinks || [] }
      case 'location_role_permissions':
        return { data: s.roleTemplateRows || [] }
      case 'impersonation_log':
        return { data: null }
      default:
        return { data: null }
    }
  }
}

// ─── shared fixtures ────────────────────────────────────────────────
const ORG_A = { id: 'org-a', name: 'Org A', slug: 'org-a', active: true }
const ORG_B = { id: 'org-b', name: 'Org B', slug: 'org-b', active: true }
const LOC_A1 = { id: 'loc-a1', name: 'A One', organization_id: 'org-a', active: true }
const LOC_A2 = { id: 'loc-a2', name: 'A Two', organization_id: 'org-a', active: true }
const LOC_B1 = { id: 'loc-b1', name: 'B One', organization_id: 'org-b', active: true }

function link({ loc, role, is_default = false, permissions = {} }) {
  return {
    profile_id: 'irrelevant',
    location_id: loc.id,
    role,
    is_default,
    permissions,
    unifi_door_access: false,
    locations: loc,
  }
}

function setup(scenario) {
  const { db, queries } = makeDb(respondFor(scenario))
  createClient.mockReturnValue(db)
  authUser = { id: scenario.profile.id, email: scenario.profile.email }
  return { queries }
}

beforeEach(() => {
  vi.clearAllMocks()
  cookieMap.clear()
  headerMap.clear()
  authUser = null
})

describe('getCurrentUser — master path (SAAS-4 must not touch it)', () => {
  const masterProfile = {
    id: 'master-1', role: 'master', full_name: 'The Master',
    email: 'master@un1t.ie', employment_type: null, active: true,
  }

  it('BYTE-IDENTICAL fixture — the only SAAS-4 addition is orgAdminOrgIds: []', async () => {
    setup({
      profile: masterProfile,
      links: [],
      allLocations: [LOC_A1, LOC_A2, LOC_B1],
      orgs: [ORG_A, ORG_B],
    })

    const user = await getCurrentUser()

    // Full-object pin. Everything except orgAdminOrgIds is the exact
    // pre-SAAS-4 shape — if this diff grows, the master path changed.
    expect(user).toEqual({
      ...masterProfile,
      user: { id: 'master-1', email: 'master@un1t.ie' },
      locations: [LOC_A1, LOC_A2, LOC_B1],
      activeLocation: LOC_A1,
      organizationsById: { 'org-a': ORG_A, 'org-b': ORG_B },
      activeOrganization: ORG_A,
      orgAdminOrgIds: [],
      rolesByLocation: {},
      assignmentsByLocation: {},
      activeAssignment: null,
      roleTemplatesByLocation: {},
      activeRoleTemplate: null,
      acDeviceTemplatesByLocation: {},
      activeAcDeviceTemplate: null,
      role: 'master',
      profileRole: 'master',
      isMaster: true,
      impersonatingFrom: null,
    })
  })

  it('never queries profile_organizations for a master (fetch skipped)', async () => {
    const { queries } = setup({
      profile: masterProfile,
      links: [],
      allLocations: [LOC_A1],
      orgs: [ORG_A],
    })

    await getCurrentUser()

    expect(queries.filter(q => q.table === 'profile_organizations')).toHaveLength(0)
  })
})

describe('getCurrentUser — rollout safety (zero profile_organizations rows)', () => {
  const ownerProfile = {
    id: 'owner-1', role: 'owner', full_name: 'Own Er',
    email: 'owner@un1t.ie', employment_type: 'fte', active: true,
  }

  it('a regular owner with no grants gets EXACTLY today\'s user object (fixture pin)', async () => {
    const ownerLink = link({ loc: LOC_A1, role: 'owner', is_default: true, permissions: { pipeline: true } })
    setup({
      profile: ownerProfile,
      links: [ownerLink],
      orgLinks: [],       // ← the rollout state for every existing user
      orgs: [ORG_A],
    })

    const user = await getCurrentUser()

    expect(user).toEqual({
      ...ownerProfile,
      user: { id: 'owner-1', email: 'owner@un1t.ie' },
      locations: [LOC_A1],
      activeLocation: LOC_A1,
      organizationsById: { 'org-a': ORG_A },
      activeOrganization: ORG_A,
      orgAdminOrgIds: [],
      rolesByLocation: { 'loc-a1': 'owner' },
      assignmentsByLocation: {
        'loc-a1': {
          role: 'owner',
          permissions: { pipeline: true },
          is_default: true,
          unifi_door_access: false,
        },
      },
      activeAssignment: {
        role: 'owner',
        permissions: { pipeline: true },
        is_default: true,
        unifi_door_access: false,
      },
      roleTemplatesByLocation: {},
      activeRoleTemplate: null,
      acDeviceTemplatesByLocation: {},
      activeAcDeviceTemplate: null,
      role: 'owner',
      profileRole: 'owner',
      isMaster: false,
      impersonatingFrom: null,
    })
  })

  it('performs NO locations query when there are no grants (no expansion fetch)', async () => {
    const { queries } = setup({
      profile: ownerProfile,
      links: [link({ loc: LOC_A1, role: 'owner' })],
      orgLinks: [],
      orgs: [ORG_A],
    })

    await getCurrentUser()

    // Non-masters never fetched `locations` directly before SAAS-4;
    // with zero grants that must still be true.
    expect(queries.filter(q => q.table === 'locations')).toHaveLength(0)
  })
})

describe('getCurrentUser — org admin (SAAS-4)', () => {
  const orgAdminProfile = {
    id: 'oa-1', role: 'staff', full_name: 'Org Admin',
    email: 'oa@tenant.ie', employment_type: 'fte', active: true,
  }
  const grant = { profile_id: 'oa-1', organization_id: 'org-a', role: 'org_admin' }

  it('expands to all org locations, acts as owner there, explicit assignment role preserved', async () => {
    const staffLink = link({ loc: LOC_A1, role: 'staff' })
    const { queries } = setup({
      profile: orgAdminProfile,
      links: [staffLink],
      orgLinks: [grant],
      orgLocations: [LOC_A1, LOC_A2],
      orgs: [ORG_A, ORG_B],
      roleTemplateRows: [
        // Owner template at the synthetic location — must apply to the
        // org admin the same way it applies to a real owner there.
        { location_id: 'loc-a2', role: 'owner', employment_type: 'all', permissions: { events: false }, ac_device_ids: null },
      ],
    })

    const user = await getCurrentUser()

    expect(user.orgAdminOrgIds).toEqual(['org-a'])
    expect(user.locations.map(l => l.id)).toEqual(['loc-a1', 'loc-a2'])
    // Explicit staff assignment keeps its role; the unassigned org
    // location gets the synthetic owner role.
    expect(user.rolesByLocation).toEqual({ 'loc-a1': 'staff', 'loc-a2': 'owner' })
    expect(user.assignmentsByLocation['loc-a1']).toEqual({
      role: 'staff', permissions: {}, is_default: false, unifi_door_access: false,
    })
    expect(user.assignmentsByLocation['loc-a2']).toEqual({
      role: 'owner', permissions: {}, is_default: false, unifi_door_access: false,
    })
    // Active location falls to the first reachable one (the explicit
    // assignment) → the request role is the EXPLICIT role there.
    expect(user.activeLocation.id).toBe('loc-a1')
    expect(user.role).toBe('staff')
    // The owner role template at the synthetic location applies.
    expect(user.roleTemplatesByLocation['loc-a2']).toEqual({ events: false })
    // organizationsById carries the admin org.
    expect(user.organizationsById['org-a']).toEqual(ORG_A)
    // The expansion query was org-bounded to exactly the granted orgs.
    const locQueries = queries.filter(q => q.table === 'locations')
    expect(locQueries).toHaveLength(1)
    expect(findCall(locQueries[0], 'in')).toEqual(['in', 'organization_id', ['org-a']])
  })

  it('a pure org admin (zero explicit assignments) is owner everywhere in the org', async () => {
    setup({
      profile: { ...orgAdminProfile, role: 'staff' },
      links: [],
      orgLinks: [grant],
      orgLocations: [LOC_A1, LOC_A2],
      orgs: [ORG_A],
    })

    const user = await getCurrentUser()

    expect(user.locations.map(l => l.id)).toEqual(['loc-a1', 'loc-a2'])
    expect(user.rolesByLocation).toEqual({ 'loc-a1': 'owner', 'loc-a2': 'owner' })
    expect(user.role).toBe('owner')
    // getOwnerOrganizationIds — the org-scoped resource helper
    // (contracts, mig 106) — now includes the admin org.
    expect(getOwnerOrganizationIds(user)).toEqual(['org-a'])
  })

  it('does NOT see another org\'s locations or org row', async () => {
    setup({
      profile: orgAdminProfile,
      links: [],
      orgLinks: [grant],
      // The responder only returns org-a locations because the query
      // itself is org-bounded — mirrored here.
      orgLocations: [LOC_A1],
      orgs: [ORG_A, ORG_B],
    })

    const user = await getCurrentUser()

    expect(user.locations.map(l => l.id)).toEqual(['loc-a1'])
    expect(user.locations.some(l => l.organization_id === 'org-b')).toBe(false)
    expect(user.organizationsById['org-b']).toBeUndefined()
    expect(user.orgAdminOrgIds).toEqual(['org-a'])
  })

  it('admin org with ZERO active locations still surfaces the org row + admin id', async () => {
    setup({
      profile: orgAdminProfile,
      links: [link({ loc: LOC_B1, role: 'staff' })],
      orgLinks: [grant],
      orgLocations: [],   // org-a has no active locations yet
      orgs: [ORG_A, ORG_B],
    })

    const user = await getCurrentUser()

    expect(user.orgAdminOrgIds).toEqual(['org-a'])
    // organizationsById unions the admin org in even though no
    // location references it.
    expect(user.organizationsById['org-a']).toEqual(ORG_A)
    expect(user.organizationsById['org-b']).toEqual(ORG_B)
    expect(getOwnerOrganizationIds(user)).toEqual(['org-a'])
  })
})
