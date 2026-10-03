// Mocked-pipeline tests for getCurrentUser() — SAAS-4 (mig 417).
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

// PROFILESPREAD.1 — auth.js logs a failed profile read.
vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { getCurrentUser, getOwnerOrganizationIds } from './auth.js'
import { createClient } from '@supabase/supabase-js'
import { USER_LOCATION_COLUMNS } from './location-secrets.js'
import { PROFILE_AUTH_SELECT, USER_PROFILE_COLUMNS } from './user-profile.js'
import { logError } from './log.js'

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
      case 'profiles': {
        // ACTIVEUSER.1 — `profilesById` scripts the impersonation TARGET read
        // (a second profiles query, by a different id). Absent, every
        // profiles read answers the one scripted caller, as before.
        const idCall = q.calls.find(c => c[0] === 'eq' && c[1] === 'id')
        if (s.profilesById && idCall && s.profilesById[idCall[2]]) {
          return { data: s.profilesById[idCall[2]] }
        }
        return { data: s.profile }
      }
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
        return { data: s.openImpersonation ? { id: 'imp-1' } : null }
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
      supportSession: null,
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
      supportSession: null,
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

describe('getCurrentUser — a permanently deleted staff member (STAFFDELETE.1)', () => {
  const living = { id: 'coach-1', role: 'staff', full_name: 'Former Coach', email: 'coach@example.test', employment_type: 'fte', active: true }
  const scenario = (profile) => ({ profile, links: [link({ loc: LOC_A1, role: 'staff', is_default: true })], orgLinks: [], orgs: [ORG_A] })

  it('control: the same profile resolves while it is alive', async () => {
    setup(scenario(living))
    expect(await getCurrentUser()).not.toBeNull()
  })

  it('a tombstone resolves to null — an access token issued before the delete gets a 401 everywhere', async () => {
    setup(scenario({ ...living, active: false, email: 'deleted+coach-1@deleted.invalid', deleted_at: '2026-09-19T10:00:00Z' }))
    expect(await getCurrentUser()).toBeNull()
  })
})

// ACTIVEUSER.1 — "Deactivate" only ever set profiles.active=false. The Supabase
// auth user is untouched, so every live session (web cookie, mobile Bearer JWT,
// studio PIN cookie) kept resolving as a fully signed-in user. One check on the
// REAL profile closes all three, because all three funnel into the same read.
describe('getCurrentUser — a deactivated staff member (ACTIVEUSER.1)', () => {
  const living = { id: 'coach-2', role: 'staff', full_name: 'Paused Coach', email: 'paused@example.test', employment_type: 'fte', active: true }
  const scenario = (profile, extra = {}) => ({
    profile, links: [link({ loc: LOC_A1, role: 'staff', is_default: true })], orgLinks: [], orgs: [ORG_A], ...extra,
  })

  // Bearer + studio paths build their clients through the (mocked)
  // supabase-js createClient, so the double grows an `auth.getUser`.
  function setupVia(source, s) {
    const { db, queries } = makeDb(respondFor(s))
    const identity = { id: s.profile.id, email: s.profile.email }
    createClient.mockReturnValue({ ...db, auth: { getUser: async () => ({ data: { user: source === 'bearer' ? identity : null } }) } })
    authUser = source === 'cookie' ? identity : null
    if (source === 'bearer') headerMap.set('authorization', 'Bearer a.supabase.jwt')
    return { queries }
  }

  async function setupStudio(s) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-role-test-key'
    const { mintStudioSession } = await import('./studio-session.js')
    cookieMap.set('studio_session', mintStudioSession({ profileId: s.profile.id, deviceId: 'dev-1', locationId: LOC_A1.id }))
    return setupVia('studio', s)
  }

  it('control: the same profile resolves on all three auth sources while it is active', async () => {
    setupVia('cookie', scenario(living))
    expect((await getCurrentUser())?.id).toBe('coach-2')
    setupVia('bearer', scenario(living))
    expect((await getCurrentUser())?.id).toBe('coach-2')
    headerMap.clear()
    await setupStudio(scenario(living))
    expect((await getCurrentUser())?.id).toBe('coach-2')
  })

  it('resolves to null on a live web cookie session', async () => {
    setupVia('cookie', scenario({ ...living, active: false }))
    expect(await getCurrentUser()).toBeNull()
  })

  it('resolves to null on a live mobile Bearer JWT', async () => {
    setupVia('bearer', scenario({ ...living, active: false }))
    expect(await getCurrentUser()).toBeNull()
  })

  it('resolves to null on a live studio_session PIN cookie', async () => {
    await setupStudio(scenario({ ...living, active: false }))
    expect(await getCurrentUser()).toBeNull()
  })

  it('stops before loading anything else — no locations, orgs or templates are read for a deactivated caller', async () => {
    const { queries } = setupVia('cookie', scenario({ ...living, active: false }))
    await getCurrentUser()
    expect(queries.map(q => q.table)).toEqual(['profiles'])
  })

  // STRICTLY `=== false`. A row whose `active` is missing must never be locked
  // out by this check: the column is NOT NULL DEFAULT true today, but a
  // narrowed select, a view or a fixture that omits it would otherwise turn
  // "we did not read it" into "everyone is signed out".
  it.each([['null', null], ['undefined', undefined]])('active: %s still resolves', async (_label, value) => {
    setupVia('cookie', scenario({ ...living, active: value }))
    expect((await getCurrentUser())?.id).toBe('coach-2')
  })

  it('an active master is unaffected', async () => {
    setupVia('cookie', {
      profile: { id: 'master-1', role: 'master', full_name: 'The Master', email: 'master@un1t.ie', employment_type: null, active: true },
      links: [], allLocations: [LOC_A1], orgs: [ORG_A],
    })
    const user = await getCurrentUser()
    expect(user.isMaster).toBe(true)
    expect(user.locations.map(l => l.id)).toEqual(['loc-a1'])
  })

  it('a deactivated MASTER is refused too — the check reads the real profile, not the role', async () => {
    setupVia('cookie', {
      profile: { id: 'master-2', role: 'master', full_name: 'Former Master', email: 'former@un1t.ie', employment_type: null, active: false },
      links: [], allLocations: [LOC_A1], orgs: [ORG_A],
    })
    expect(await getCurrentUser()).toBeNull()
  })

  describe('"View as" — impersonation target', () => {
    const MASTER = { id: '11111111-1111-4111-8111-111111111111', role: 'master', full_name: 'The Master', email: 'master@un1t.ie', employment_type: null, active: true }
    const TARGET_ID = '22222222-2222-4222-8222-222222222222'
    const target = { id: TARGET_ID, role: 'staff', full_name: 'Paused Coach', email: 'paused@example.test', employment_type: 'fte', active: false }
    const viewAs = (targetProfile) => {
      cookieMap.set('un1t_impersonate', TARGET_ID)
      setupVia('cookie', {
        profile: MASTER, profilesById: { [MASTER.id]: MASTER, [TARGET_ID]: targetProfile },
        openImpersonation: true, links: [], allLocations: [LOC_A1], orgs: [ORG_A],
      })
    }

    // KEPT ON PURPOSE. The gate on "View as" is the MASTER's own session (real
    // profile, active, open impersonation_log row), and a master reproducing
    // what a deactivated person saw is exactly what the tool is for. It grants
    // the deactivated person nothing: their own sessions die at the check
    // above, which reads the REAL profile.
    it('a master can still view as a deactivated (non-tombstone) profile', async () => {
      viewAs(target)
      const user = await getCurrentUser()
      expect(user.id).toBe(TARGET_ID)
      expect(user.active).toBe(false)
      expect(user.impersonatingFrom).toEqual({ masterId: MASTER.id, masterName: 'The Master', masterEmail: 'master@un1t.ie' })
    })

    it('a tombstone is still never a target — the master stays themselves', async () => {
      viewAs({ ...target, deleted_at: '2026-09-19T10:00:00Z' })
      const user = await getCurrentUser()
      expect(user.id).toBe(MASTER.id)
      expect(user.impersonatingFrom).toBeNull()
    })

    it('a DEACTIVATED master cannot impersonate their way back in', async () => {
      cookieMap.set('un1t_impersonate', TARGET_ID)
      const gone = { ...MASTER, active: false }
      setupVia('cookie', {
        profile: gone, profilesById: { [MASTER.id]: gone, [TARGET_ID]: { ...target, active: true } },
        openImpersonation: true, links: [], allLocations: [LOC_A1], orgs: [ORG_A],
      })
      expect(await getCurrentUser()).toBeNull()
    })
  })
})

// ─── SECFIX.3a ──────────────────────────────────────────────────────
// The whole user object is serialised into every CRM page (layout →
// AppShellServer → <AppShell user={user}>, a client component). The
// location rows in it must carry no credential value.

describe('getCurrentUser — SECFIX.3a: location loads name their columns', () => {
  const selectsOn = (queries, table) =>
    queries.filter((q) => q.table === table).map((q) => findCall(q, 'select')?.[1])

  it('staff + org admin: the profile_locations embed and the org-expanded load name USER_LOCATION_COLUMNS', async () => {
    const { queries } = setup({
      profile: { id: 'oa-2', role: 'staff', full_name: 'Org Admin', email: 'oa2@tenant.ie', employment_type: 'fte', active: true },
      links: [link({ loc: LOC_A1, role: 'staff' })],
      orgLinks: [{ profile_id: 'oa-2', organization_id: 'org-a', role: 'org_admin' }],
      orgLocations: [LOC_A1, LOC_A2],
      orgs: [ORG_A],
    })
    await getCurrentUser()
    expect(selectsOn(queries, 'profile_locations')).toContain(`*, locations(${USER_LOCATION_COLUMNS})`)
    expect(selectsOn(queries, 'locations')).toEqual([USER_LOCATION_COLUMNS])
    for (const s of [...selectsOn(queries, 'profile_locations'), ...selectsOn(queries, 'locations')]) {
      expect(s).not.toMatch(/locations\(\*\)/)
    }
  })

  it('master: the all-locations load names USER_LOCATION_COLUMNS', async () => {
    const { queries } = setup({
      profile: { id: 'm-2', role: 'master', full_name: 'M', email: 'm2@un1t.ie', employment_type: null, active: true },
      links: [],
      allLocations: [LOC_A1],
      orgs: [ORG_A],
    })
    await getCurrentUser()
    expect(selectsOn(queries, 'locations')).toEqual([USER_LOCATION_COLUMNS])
  })
})

describe('getCurrentUser — SECFIX.3a + PROFILESPREAD.1: no settings and no credential on any location row', () => {
  const SECRET_LOC = {
    id: 'loc-s', name: 'Secret Studio', organization_id: 'org-a', active: true,
    sensibo_api_key: 'SYNTH-SENSIBO-KEY', thinq_pat: 'SYNTH-THINQ-PAT',
    settings: {
      glofox: { branch_id: 'b1', api_key: 'SYNTH-GLOFOX-KEY', api_token: 'SYNTH-GLOFOX-TOKEN', webhook_secret: 'SYNTH-GLOFOX-WHSEC', trial_membership_id: 'm1' },
      unifi: { host: 'https://unifi.example', api_token: 'SYNTH-UNIFI-TOKEN' },
      customer_agent: { enabled: true, test_phones: ['+353000000001'] },
    },
  }
  const expectNoSecret = (user) => expect(JSON.stringify(user)).not.toMatch(/SYNTH-|test_phones|\+353000/)

  it('a plain staff member: locations, activeLocation (the default link) and nothing else change', async () => {
    setup({
      profile: { id: 'st-1', role: 'staff', full_name: 'Staff', email: 'st@un1t.ie', employment_type: 'fte', active: true },
      links: [link({ loc: SECRET_LOC, role: 'staff', is_default: true })],
      orgs: [ORG_A],
    })
    const user = await getCurrentUser()
    expectNoSecret(user)
    expect(user.activeLocation).not.toHaveProperty('settings')
    expect(user.activeLocation).not.toHaveProperty('sensibo_api_key')
    expect(user.activeLocation).toEqual({ id: 'loc-s', name: 'Secret Studio', organization_id: 'org-a', active: true })
    expect(user.rolesByLocation).toEqual({ 'loc-s': 'staff' })
  })

  it('a master: no active location carries settings or a credential', async () => {
    setup({
      profile: { id: 'm-1', role: 'master', full_name: 'M', email: 'm@un1t.ie', employment_type: null, active: true },
      links: [],
      allLocations: [SECRET_LOC, LOC_A1],
      orgs: [ORG_A],
    })
    const user = await getCurrentUser()
    expectNoSecret(user)
    expect(user.locations[0]).not.toHaveProperty('settings')
    expect(user.locations[1]).toBe(LOC_A1) // nothing to drop → the same object
  })

  it('an org admin: the org-expanded locations carry no settings or credential', async () => {
    setup({
      profile: { id: 'oa-1', role: 'staff', full_name: 'Org Admin', email: 'oa@tenant.ie', employment_type: 'fte', active: true },
      links: [],
      orgLinks: [{ profile_id: 'oa-1', organization_id: 'org-a', role: 'org_admin' }],
      orgLocations: [SECRET_LOC],
      orgs: [ORG_A],
    })
    const user = await getCurrentUser()
    expectNoSecret(user)
    expect(user.locations.map((l) => l.id)).toEqual(['loc-s'])
  })

  it('the user object carries no location settings at all (the automations pages read their own)', async () => {
    setup({
      profile: { id: 'st-2', role: 'owner', full_name: 'O', email: 'o@example.test', employment_type: 'fte', active: true },
      links: [link({ loc: SECRET_LOC, role: 'owner', is_default: true })],
      orgs: [ORG_A],
    })
    const user = await getCurrentUser()
    expect(JSON.stringify(user)).not.toMatch(/"settings"|customer_agent|test_phones/)
  })
})

// ─── PROFILESPREAD.1 ────────────────────────────────────────────────
// The user object is serialised into every page. It carries the ten profile
// columns its readers use, never pin_hash / pay / UniFi-id / tombstone
// bookkeeping, for the real person AND for a master's "View as" target.

describe('getCurrentUser — PROFILESPREAD.1: named profile columns', () => {
  const FULL = (over = {}) => ({
    id: 'p-1', role: 'staff', full_name: 'Plain Staff', email: 'p@example.test', employment_type: 'fte', active: true,
    avatar_url: null, permissions: { landing_preference: 'today' }, email_signature: 'sig', email_signature_rich: null,
    pin_hash: 'SYNTH-PIN-HASH', pin_set_at: '2026-01-01T00:00:00Z', pin_failed_count: 0, pin_locked_until: null,
    annual_salary: 12345, hourly_rate: 67, contracted_hours_per_week: 39, annual_leave_entitlement: 20, overtime_rate: 1.5,
    unifi_user_id: 'SYNTH-UNIFI-ID', unifi_door_access: true, home_screen_path: '/studio',
    two_factor_enabled: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    deleted_at: null, deleted_by: null, deleted_role: null, auth_disposition: null, auth_completed_at: null,
    ...over,
  })
  const DROPPED = ['pin_hash', 'pin_set_at', 'pin_failed_count', 'pin_locked_until', 'annual_salary', 'hourly_rate',
    'contracted_hours_per_week', 'annual_leave_entitlement', 'overtime_rate', 'unifi_user_id', 'unifi_door_access',
    'home_screen_path', 'two_factor_enabled', 'created_at', 'updated_at', 'deleted_at', 'deleted_by', 'deleted_role',
    'auth_disposition', 'auth_completed_at']

  it('selects PROFILE_AUTH_SELECT, never *', async () => {
    const { queries } = setup({ profile: FULL(), links: [link({ loc: LOC_A1, role: 'staff', is_default: true })], orgs: [ORG_A] })
    await getCurrentUser()
    const selects = queries.filter((q) => q.table === 'profiles').map((q) => findCall(q, 'select')?.[1])
    expect(selects).toEqual([PROFILE_AUTH_SELECT])
  })

  it('the user object carries the ten columns and none of the others (a stray value from the read is dropped)', async () => {
    setup({ profile: FULL(), links: [link({ loc: LOC_A1, role: 'staff', is_default: true })], orgs: [ORG_A] })
    const user = await getCurrentUser()
    for (const k of DROPPED) expect([k, Object.prototype.hasOwnProperty.call(user, k)]).toEqual([k, false])
    expect(JSON.stringify(user)).not.toMatch(/SYNTH-|12345/)
    for (const k of USER_PROFILE_COLUMNS.filter((c) => c !== 'role')) expect(user[k]).toEqual(FULL()[k])
    expect(user.role).toBe('staff')
    expect(user.profileRole).toBe('staff')
  })

  it('"View as": the TARGET is read with the same named select, and its pin/pay never reach the master\'s page', async () => {
    // UUIDs, as the existing "View as" cases use (readImpersonationTarget is real).
    const M_ID = '33333333-3333-4333-8333-333333333333'
    const T_ID = '44444444-4444-4444-8444-444444444444'
    cookieMap.set('un1t_impersonate', T_ID)
    const master = FULL({ id: M_ID, role: 'master', full_name: 'M', email: 'm9@example.test' })
    const { queries } = setup({
      profile: master,
      profilesById: { [M_ID]: master, [T_ID]: FULL({ id: T_ID, full_name: 'Target', pin_hash: 'SYNTH-TARGET-PIN', hourly_rate: 99 }) },
      openImpersonation: true,
      links: [link({ loc: LOC_A1, role: 'staff', is_default: true })],
      allLocations: [LOC_A1],
      orgs: [ORG_A],
    })
    const user = await getCurrentUser()
    expect(user.id).toBe(T_ID)
    expect(queries.filter((q) => q.table === 'profiles').map((q) => findCall(q, 'select')?.[1]))
      .toEqual([PROFILE_AUTH_SELECT, PROFILE_AUTH_SELECT])
    expect(JSON.stringify(user)).not.toMatch(/SYNTH-TARGET-PIN/)
    expect(user).not.toHaveProperty('hourly_rate')
  })

  it('the tombstone check still sees deleted_at (selected, not spread)', async () => {
    // active: true and a live membership, so only isTombstone can refuse it
    // (an inactive profile is refused on its own, which would make this vacuous).
    setup({
      profile: FULL({ deleted_at: '2026-09-19T10:00:00Z', active: true }),
      links: [link({ loc: LOC_A1, role: 'staff', is_default: true })],
      orgs: [ORG_A],
    })
    expect(await getCurrentUser()).toBeNull()
  })

  it('the same profile without deleted_at signs in (the tombstone case above is not vacuous)', async () => {
    setup({ profile: FULL({ active: true }), links: [link({ loc: LOC_A1, role: 'staff', is_default: true })], orgs: [ORG_A] })
    expect((await getCurrentUser())?.id).toBe('p-1')
  })

  it('the View-as target read errors: logged (code only), master stays themselves', async () => {
    const M_ID = '55555555-5555-4555-8555-555555555555'
    const T_ID = '66666666-6666-4666-8666-666666666666'
    cookieMap.set('un1t_impersonate', T_ID)
    const master = FULL({ id: M_ID, role: 'master', full_name: 'M', email: 'm8@example.test' })
    const scenario = { profile: master, openImpersonation: true, links: [], allLocations: [LOC_A1], orgs: [ORG_A] }
    const base = respondFor(scenario)
    const { db, queries } = makeDb((q) => {
      const idCall = q.calls.find((c) => c[0] === 'eq' && c[1] === 'id')
      if (q.table === 'profiles' && idCall?.[2] === T_ID) {
        return { data: null, error: { code: '42703', message: 'column x does not exist' } }
      }
      return base(q)
    })
    createClient.mockReturnValue(db)
    authUser = { id: M_ID, email: master.email }
    const user = await getCurrentUser()
    expect(user.id).toBe(M_ID)
    expect(user.full_name).toBe('M')
    expect(user.impersonatingFrom ?? null).toBeNull()
    expect(queries.filter((q) => q.table === 'profiles')).toHaveLength(2)
    expect(logError).toHaveBeenCalledWith('auth', expect.stringMatching(/impersonation target read failed; master stays themselves/), { code: '42703' })
  })

  it('a failed profile read is logged (code only) and still resolves null', async () => {
    const { db } = makeDb((q) => (q.table === 'profiles' ? { data: null, error: { code: '42703', message: 'column x does not exist' } } : { data: null }))
    createClient.mockReturnValue(db)
    authUser = { id: 'p-1', email: 'p@example.test' }
    expect(await getCurrentUser()).toBeNull()
    expect(logError).toHaveBeenCalledWith('auth', expect.stringMatching(/profile read failed/), { code: '42703' })
  })

  it('"no row" (PGRST116) is not logged: a signed-in auth user without a profile is a member, not a fault', async () => {
    const { db } = makeDb((q) => (q.table === 'profiles' ? { data: null, error: { code: 'PGRST116', message: 'no rows' } } : { data: null }))
    createClient.mockReturnValue(db)
    authUser = { id: 'member-1', email: 'm@example.test' }
    expect(await getCurrentUser()).toBeNull()
    expect(logError).not.toHaveBeenCalled()
  })
})

// AUTHUSERPICK.1 — the Supabase auth user (identities, app_metadata,
// user_metadata, phone, factors, timestamps) rode on `user.user` into every
// page (AppShell). It is now exactly { id, email } on every auth source.
describe('getCurrentUser — user.user is { id, email } on every source (AUTHUSERPICK.1)', () => {
  const profile = { id: 'coach-9', role: 'staff', full_name: 'Synth Coach', email: 'coach9@example.test', employment_type: 'fte', active: true }
  const FAT = (id, email) => ({
    id, email, phone: '+353000000000', aud: 'authenticated', role: 'authenticated',
    app_metadata: { provider: 'email', providers: ['email', 'google'] },
    user_metadata: { full_name: 'SYNTH-META-NAME' },
    identities: [{ identity_id: 'SYNTH-IDENTITY', provider: 'google', identity_data: { email, sub: 'SYNTH-SUB' } }],
    factors: [{ id: 'SYNTH-FACTOR', factor_type: 'totp' }],
    confirmed_at: '2026-01-01T00:00:00Z', last_sign_in_at: '2026-09-01T00:00:00Z',
  })
  const scenario = (extra = {}) => ({
    profile, links: [link({ loc: LOC_A1, role: 'staff', is_default: true })], orgLinks: [], orgs: [ORG_A], ...extra,
  })
  const LEAK = /SYNTH-|\+353000000000|identities|app_metadata|user_metadata|factors|last_sign_in_at/

  function via(source, s, identity) {
    const { db } = makeDb(respondFor(s))
    createClient.mockReturnValue({ ...db, auth: { getUser: async () => ({ data: { user: source === 'bearer' ? identity : null } }) } })
    authUser = source === 'cookie' ? identity : null
    if (source === 'bearer') headerMap.set('authorization', 'Bearer a.supabase.jwt')
  }

  it.each(['cookie', 'bearer'])('%s session: user.user is exactly { id, email }, and nothing else of the auth user is on the object', async (source) => {
    via(source, scenario(), FAT(profile.id, profile.email))
    const user = await getCurrentUser()
    expect(user.id).toBe(profile.id)
    expect(user.user).toEqual({ id: profile.id, email: profile.email })
    expect(JSON.stringify(user)).not.toMatch(LEAK)
  })

  it('studio PIN session: the same { id, email } shape it always had', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-role-test-key'
    const { mintStudioSession } = await import('./studio-session.js')
    cookieMap.set('studio_session', mintStudioSession({ profileId: profile.id, deviceId: 'dev-1', locationId: LOC_A1.id }))
    via('studio', scenario(), null)
    const user = await getCurrentUser()
    expect(user.user).toEqual({ id: profile.id, email: profile.email })
  })

  it('"View as": user.user stays the MASTER\'s { id, email }; nothing else of the master\'s auth user rides along', async () => {
    const M_ID = '55555555-5555-4555-8555-555555555555'
    const T_ID = '66666666-6666-4666-8666-666666666666'
    const master = { id: M_ID, role: 'master', full_name: 'Synth Master', email: 'm5@example.test', employment_type: null, active: true }
    const target = { id: T_ID, role: 'staff', full_name: 'Synth Target', email: 't6@example.test', employment_type: 'fte', active: true }
    cookieMap.set('un1t_impersonate', T_ID)
    via('cookie', {
      profile: master, profilesById: { [M_ID]: master, [T_ID]: target }, openImpersonation: true,
      links: [link({ loc: LOC_A1, role: 'staff', is_default: true })], allLocations: [LOC_A1], orgs: [ORG_A],
    }, FAT(M_ID, master.email))
    const user = await getCurrentUser()
    expect(user.id).toBe(T_ID)
    expect(user.user).toEqual({ id: M_ID, email: master.email })
    expect(JSON.stringify(user)).not.toMatch(LEAK)
  })
})
