import { describe, it, expect } from 'vitest'
import {
  buildRolesByLocation,
  resolveActiveLocationRole,
  expandOrgAdminAccess,
  assertLocationAccess,
  assertLocationAccessOr404,
  assertOrganizationAccess,
  assertOrganizationAccessOr404,
  assertOrganizationAdmin,
  getUserLocationIds,
  getOwnerOrganizationIds,
  requireInboxPermission,
  hasRoleAtLocation,
} from './auth.js'

// Per-location roles landed in mig 051. The IO-heavy getCurrentUser()
// pipeline is hard to unit test (Supabase calls, Next cookies/headers)
// but the role-derivation logic was pulled out into pure helpers
// specifically so we could pin its behaviour with cheap tests.

describe('buildRolesByLocation', () => {
  it('returns an empty object for null / undefined / empty inputs', () => {
    expect(buildRolesByLocation(null)).toEqual({})
    expect(buildRolesByLocation(undefined)).toEqual({})
    expect(buildRolesByLocation([])).toEqual({})
  })

  it('builds a {loc_id → role} map from profile_locations rows', () => {
    const links = [
      { location_id: 'hatch', role: 'owner' },
      { location_id: 'stillorgan', role: 'head_coach' },
    ]
    expect(buildRolesByLocation(links)).toEqual({
      hatch: 'owner',
      stillorgan: 'head_coach',
    })
  })

  it('skips links missing location_id or role (defensive)', () => {
    const links = [
      { location_id: 'hatch', role: 'owner' },
      { location_id: null, role: 'staff' },
      { location_id: 'stillorgan' },         // no role
      { role: 'manager' },                   // no location_id
      null,                                  // null entry — should not throw
    ]
    expect(buildRolesByLocation(links)).toEqual({ hatch: 'owner' })
  })

  it('last write wins on duplicate location_ids (DB unique constraint should prevent this anyway)', () => {
    const links = [
      { location_id: 'hatch', role: 'staff' },
      { location_id: 'hatch', role: 'owner' },
    ]
    expect(buildRolesByLocation(links)).toEqual({ hatch: 'owner' })
  })
})

describe('resolveActiveLocationRole', () => {
  it('returns "master" for any master user, regardless of per-location data', () => {
    expect(resolveActiveLocationRole({
      profile: { role: 'master' },
      rolesByLocation: { hatch: 'owner', stillorgan: 'staff' },
      activeLocationId: 'stillorgan',
    })).toBe('master')

    // Even with no per-location rows + no active location
    expect(resolveActiveLocationRole({
      profile: { role: 'master' },
      rolesByLocation: {},
      activeLocationId: null,
    })).toBe('master')
  })

  it('returns the role at the active location for non-master users', () => {
    expect(resolveActiveLocationRole({
      profile: { role: 'owner' },
      rolesByLocation: { hatch: 'owner', stillorgan: 'head_coach' },
      activeLocationId: 'hatch',
    })).toBe('owner')

    expect(resolveActiveLocationRole({
      profile: { role: 'owner' },
      rolesByLocation: { hatch: 'owner', stillorgan: 'head_coach' },
      activeLocationId: 'stillorgan',
    })).toBe('head_coach')
  })

  it('the canonical "owner at Hatch, head_coach at Stillorgan" scenario flips on switch', () => {
    // The user split that motivated mig 051 in the first place.
    const profile = { role: 'owner' }
    const rolesByLocation = { hatch: 'owner', stillorgan: 'head_coach' }
    expect(resolveActiveLocationRole({ profile, rolesByLocation, activeLocationId: 'hatch' })).toBe('owner')
    expect(resolveActiveLocationRole({ profile, rolesByLocation, activeLocationId: 'stillorgan' })).toBe('head_coach')
  })

  it('falls back to highest assignment role when active location has no entry', () => {
    // E.g. activeLocation is set to a location the user doesn't belong
    // to (cookie went stale, or master without explicit assignment at
    // that location). Should give the user their best role globally.
    expect(resolveActiveLocationRole({
      profile: { role: 'manager' },
      rolesByLocation: { hatch: 'manager', stillorgan: 'head_coach' },
      activeLocationId: 'unknown-location-id',
    })).toBe('manager')
  })

  it('precedence is owner > manager > head_coach > staff', () => {
    expect(resolveActiveLocationRole({
      profile: { role: 'staff' },
      rolesByLocation: { a: 'staff', b: 'manager', c: 'head_coach' },
      activeLocationId: null,
    })).toBe('manager')

    expect(resolveActiveLocationRole({
      profile: { role: 'staff' },
      rolesByLocation: { a: 'staff', b: 'owner', c: 'head_coach' },
      activeLocationId: null,
    })).toBe('owner')

    expect(resolveActiveLocationRole({
      profile: { role: 'staff' },
      rolesByLocation: { a: 'staff', b: 'staff', c: 'head_coach' },
      activeLocationId: null,
    })).toBe('head_coach')
  })

  it('falls back to profile.role when there are zero assignments and no active location', () => {
    // Defensive — a user freshly created without any profile_locations
    // rows (or a master being demoted mid-flight). Lets the rest of
    // the auth pipeline keep functioning until the next save populates
    // assignments.
    expect(resolveActiveLocationRole({
      profile: { role: 'staff' },
      rolesByLocation: {},
      activeLocationId: null,
    })).toBe('staff')

    expect(resolveActiveLocationRole({
      profile: { role: 'manager' },
      rolesByLocation: {},
      activeLocationId: 'hatch',  // active set, but no role there
    })).toBe('manager')
  })

  it('handles null/undefined inputs without throwing', () => {
    expect(() => resolveActiveLocationRole({
      profile: null, rolesByLocation: {}, activeLocationId: null,
    })).not.toThrow()

    expect(() => resolveActiveLocationRole({
      profile: { role: 'owner' }, rolesByLocation: null, activeLocationId: null,
    })).not.toThrow()
  })

  it('master flag wins even if profile_locations also contains a master entry (defensive)', () => {
    // master should never appear in profile_locations (DB CHECK
    // constraint blocks it post-mig-051) but in case it ever does
    // — say from a partial restore — the platform flag still wins.
    expect(resolveActiveLocationRole({
      profile: { role: 'master' },
      rolesByLocation: { hatch: 'master' },  // hypothetically
      activeLocationId: 'hatch',
    })).toBe('master')
  })
})

// ─── expandOrgAdminAccess (SAAS-4, mig 417) ─────────────────────────────
// Pure org-bounded mirror of the master expansion inside getCurrentUser.
// The IO side (which orgs' locations get fetched) is pinned in
// auth.getCurrentUser.test.js; these tests pin the merge semantics.

describe('expandOrgAdminAccess', () => {
  const LOC_A1 = { id: 'loc-a1', name: 'A One', organization_id: 'org-a' }
  const LOC_A2 = { id: 'loc-a2', name: 'A Two', organization_id: 'org-a' }

  it('unions org locations into the assigned set and grants synthetic owner roles', () => {
    const out = expandOrgAdminAccess({
      locations: [LOC_A1],
      rolesByLocation: { 'loc-a1': 'staff' },
      orgLocations: [LOC_A1, LOC_A2],
    })
    expect(out.locations.map(l => l.id)).toEqual(['loc-a1', 'loc-a2'])
    // Explicit assignment keeps its role; the org location without an
    // assignment becomes synthetic owner.
    expect(out.rolesByLocation).toEqual({ 'loc-a1': 'staff', 'loc-a2': 'owner' })
    expect(out.syntheticLocationIds).toEqual(['loc-a2'])
  })

  it('an org admin with zero explicit assignments becomes owner everywhere in the org', () => {
    const out = expandOrgAdminAccess({
      locations: [],
      rolesByLocation: {},
      orgLocations: [LOC_A1, LOC_A2],
    })
    expect(out.locations.map(l => l.id)).toEqual(['loc-a1', 'loc-a2'])
    expect(out.rolesByLocation).toEqual({ 'loc-a1': 'owner', 'loc-a2': 'owner' })
    expect(out.syntheticLocationIds).toEqual(['loc-a1', 'loc-a2'])
  })

  it('does not deduplicate an assigned location into a role change (explicit owner stays owner, not synthetic)', () => {
    const out = expandOrgAdminAccess({
      locations: [LOC_A1],
      rolesByLocation: { 'loc-a1': 'owner' },
      orgLocations: [LOC_A1],
    })
    expect(out.locations).toHaveLength(1)
    expect(out.rolesByLocation).toEqual({ 'loc-a1': 'owner' })
    // Explicit rows are never reported as synthetic — no synthetic
    // empty-permissions assignment may shadow the real one.
    expect(out.syntheticLocationIds).toEqual([])
  })

  it('preserves assigned locations OUTSIDE the admin orgs untouched', () => {
    const foreign = { id: 'loc-x', name: 'Other org studio', organization_id: 'org-x' }
    const out = expandOrgAdminAccess({
      locations: [foreign],
      rolesByLocation: { 'loc-x': 'head_coach' },
      orgLocations: [LOC_A1],
    })
    expect(out.locations.map(l => l.id)).toEqual(['loc-x', 'loc-a1'])
    expect(out.rolesByLocation).toEqual({ 'loc-x': 'head_coach', 'loc-a1': 'owner' })
  })

  it('ROLLOUT SAFETY: empty/null orgLocations returns the inputs unchanged by value', () => {
    const locations = [LOC_A1]
    const rolesByLocation = { 'loc-a1': 'staff' }
    for (const orgLocations of [[], null, undefined]) {
      const out = expandOrgAdminAccess({ locations, rolesByLocation, orgLocations })
      expect(out.locations).toEqual(locations)
      expect(out.rolesByLocation).toEqual(rolesByLocation)
      expect(out.syntheticLocationIds).toEqual([])
    }
  })

  it('does not mutate its inputs', () => {
    const locations = [LOC_A1]
    const rolesByLocation = { 'loc-a1': 'staff' }
    expandOrgAdminAccess({ locations, rolesByLocation, orgLocations: [LOC_A2] })
    expect(locations).toHaveLength(1)
    expect(rolesByLocation).toEqual({ 'loc-a1': 'staff' })
  })

  it('skips malformed org location entries defensively', () => {
    const out = expandOrgAdminAccess({
      locations: [],
      rolesByLocation: {},
      orgLocations: [null, {}, { name: 'no id' }, LOC_A1],
    })
    expect(out.locations.map(l => l.id)).toEqual(['loc-a1'])
  })
})

// ─── assertLocationAccess + getUserLocationIds ──────────────────────────
// These two together form the IDOR prevention layer for any session-auth
// route that accepts a location_id from user input. The helper itself is
// pure (just constructs NextResponse objects); the tests pin every branch
// so a regression here surfaces in CI before it ships to production.
//
// Master visibility is handled upstream — getCurrentUser populates
// user.locations with every active location for masters (mig 033), so
// the helper's `(user.locations).some(...)` check correctly returns true
// for any location a master attempts to access. No master-specific code
// path is needed in the helper itself.

describe('assertLocationAccess', () => {
  // user.locations is the canonical place this helper reads from.
  const userWithLocations = {
    id: 'profile-1',
    locations: [
      { id: 'loc-hatch', name: 'Hatch Street' },
      { id: 'loc-stillorgan', name: 'Stillorgan' },
    ],
  }

  it('returns 401 when the user is null', async () => {
    const r = assertLocationAccess(null, 'loc-hatch')
    expect(r).not.toBeNull()
    expect(r.status).toBe(401)
    const body = await r.json()
    expect(body).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('returns 401 when the user is undefined', async () => {
    const r = assertLocationAccess(undefined, 'loc-hatch')
    expect(r.status).toBe(401)
  })

  it('returns null (request continues) when locationId is null', () => {
    // Some routes accept "no location filter" meaning "across all my
    // locations" — that's NOT an IDOR risk because the route is then
    // expected to scope to user.locations[*].id itself.
    expect(assertLocationAccess(userWithLocations, null)).toBeNull()
    expect(assertLocationAccess(userWithLocations, undefined)).toBeNull()
    expect(assertLocationAccess(userWithLocations, '')).toBeNull()
  })

  it('returns null when the locationId is one the user belongs to', () => {
    expect(assertLocationAccess(userWithLocations, 'loc-hatch')).toBeNull()
    expect(assertLocationAccess(userWithLocations, 'loc-stillorgan')).toBeNull()
  })

  it('returns 403 when the locationId is not in the user’s assignments (IDOR attempt)', async () => {
    const r = assertLocationAccess(userWithLocations, 'loc-some-other-tenant')
    expect(r).not.toBeNull()
    expect(r.status).toBe(403)
    const body = await r.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/Forbidden/)
    expect(body.error).toMatch(/not in your assignments/)
  })

  it('returns 403 when user has no locations at all', async () => {
    // A user whose only assignment was deleted / deactivated. Every
    // location access should be denied except the no-locationId pass-
    // through case.
    const noLoc = { id: 'p2', locations: [] }
    const r = assertLocationAccess(noLoc, 'loc-anything')
    expect(r.status).toBe(403)
  })

  it('handles missing user.locations field defensively (treats as empty)', async () => {
    const noField = { id: 'p3' }
    const r = assertLocationAccess(noField, 'loc-anything')
    expect(r.status).toBe(403)
  })

  it('master users with all-locations populated pass naturally', () => {
    // Master gets every active location loaded into user.locations by
    // getCurrentUser (mig 033). The helper does no master-specific
    // checking — the array membership test handles it correctly.
    const master = {
      id: 'master-1',
      role: 'master',
      locations: [
        { id: 'loc-hatch' },
        { id: 'loc-stillorgan' },
        { id: 'loc-ccf' },
      ],
    }
    expect(assertLocationAccess(master, 'loc-ccf')).toBeNull()
    expect(assertLocationAccess(master, 'loc-stillorgan')).toBeNull()
  })

  it('handles location entries without an id field (treats as non-match)', () => {
    // getCurrentUser produces well-formed { id, name, ... } entries
    // for every location, so a missing id is never observed in practice.
    // But: a defensive check makes sure the helper doesn't accidentally
    // PASS when an entry without an id happens to be in the array.
    // (NULL entries are not handled — getCurrentUser never produces them
    // — and would correctly throw to signal bad upstream data.)
    const odd = { id: 'p4', locations: [{ id: 'loc-real' }, { name: 'no-id' }] }
    expect(assertLocationAccess(odd, 'loc-real')).toBeNull()
    // The id-less entry should NOT match anything.
    const r = assertLocationAccess(odd, 'no-id')
    expect(r.status).toBe(403)
  })
})

// ─── assertLocationAccessOr404 ──────────────────────────────────────────
// Same membership logic as assertLocationAccess, but a forbidden location
// returns 404 instead of 403. Used on DETAIL routes (fetch-by-id → 404 if
// absent → guard the fetched row) so a cross-tenant id is indistinguishable
// from a non-existent one — closes the existence/info-disclosure leak
// (audit #17). Genuine role/permission 403s and list-route 403s are
// untouched and keep using assertLocationAccess.

describe('assertLocationAccessOr404', () => {
  const userWithLocations = {
    id: 'profile-1',
    locations: [
      { id: 'loc-hatch', name: 'Hatch Street' },
      { id: 'loc-stillorgan', name: 'Stillorgan' },
    ],
  }

  it('returns null (request continues) when the locationId is allowed', () => {
    expect(assertLocationAccessOr404(userWithLocations, 'loc-hatch')).toBeNull()
    expect(assertLocationAccessOr404(userWithLocations, 'loc-stillorgan')).toBeNull()
  })

  it('returns 404 (NOT 403) when the locationId belongs to another tenant', async () => {
    // The whole point of this helper: a cross-tenant row must look exactly
    // like a missing row so the caller can't tell the id exists elsewhere.
    const r = assertLocationAccessOr404(userWithLocations, 'loc-some-other-tenant')
    expect(r).not.toBeNull()
    expect(r.status).toBe(404)
    const body = await r.json()
    expect(body).toEqual({ success: false, error: 'Not found' })
  })

  it('returns null when locationId is null/undefined (request continues)', () => {
    expect(assertLocationAccessOr404(userWithLocations, null)).toBeNull()
    expect(assertLocationAccessOr404(userWithLocations, undefined)).toBeNull()
  })

  it('returns 401 when the user is null', async () => {
    const r = assertLocationAccessOr404(null, 'loc-hatch')
    expect(r).not.toBeNull()
    expect(r.status).toBe(401)
    const body = await r.json()
    expect(body).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('returns 404 (not 403) when user has no locations at all', async () => {
    const noLoc = { id: 'p2', locations: [] }
    const r = assertLocationAccessOr404(noLoc, 'loc-anything')
    expect(r.status).toBe(404)
  })
})

describe('getUserLocationIds', () => {
  it('returns [] for null/undefined user', () => {
    expect(getUserLocationIds(null)).toEqual([])
    expect(getUserLocationIds(undefined)).toEqual([])
  })

  it('returns [] when user has no locations field', () => {
    expect(getUserLocationIds({ id: 'p1' })).toEqual([])
  })

  it('returns [] for empty locations array', () => {
    expect(getUserLocationIds({ id: 'p1', locations: [] })).toEqual([])
  })

  it('returns the ids of every assigned location, in order', () => {
    expect(getUserLocationIds({
      id: 'p1',
      locations: [
        { id: 'loc-hatch', name: 'Hatch' },
        { id: 'loc-stillorgan', name: 'Stillorgan' },
      ],
    })).toEqual(['loc-hatch', 'loc-stillorgan'])
  })
})

// ─── Organization guards (SAAS-4, mig 417) ──────────────────────────────
// Full caller matrix per guard: master / org-admin / member (via a
// location in the org) / outsider / null. The two access guards are
// MEMBERSHIP checks (mirror private.auth_is_in_organization); the admin
// guard is the MANAGEMENT tier — master or org_admin only.

describe('organization guards — caller matrix', () => {
  const ORG_A = 'org-a'
  const ORG_B = 'org-b'

  const master = {
    id: 'm1', isMaster: true,
    organizationsById: { [ORG_A]: { id: ORG_A }, [ORG_B]: { id: ORG_B } },
    orgAdminOrgIds: [],
  }
  const orgAdminA = {
    id: 'oa1', isMaster: false,
    organizationsById: { [ORG_A]: { id: ORG_A } },
    orgAdminOrgIds: [ORG_A],
  }
  const memberA = {
    id: 'mem1', isMaster: false,
    // Reachable via a location membership only — no admin grant.
    organizationsById: { [ORG_A]: { id: ORG_A } },
    orgAdminOrgIds: [],
  }
  const outsider = {
    id: 'out1', isMaster: false,
    organizationsById: {},
    orgAdminOrgIds: [],
  }

  describe('assertOrganizationAccess', () => {
    it('401 for a null user', async () => {
      const r = assertOrganizationAccess(null, ORG_A)
      expect(r.status).toBe(401)
      expect(await r.json()).toEqual({ success: false, error: 'Unauthorized' })
    })

    it('null orgId passes through (no specific org — route scopes itself)', () => {
      expect(assertOrganizationAccess(memberA, null)).toBeNull()
      expect(assertOrganizationAccess(memberA, undefined)).toBeNull()
      expect(assertOrganizationAccess(memberA, '')).toBeNull()
    })

    it('master passes for any org (even one not in organizationsById)', () => {
      expect(assertOrganizationAccess(master, ORG_A)).toBeNull()
      expect(assertOrganizationAccess(master, 'org-inactive-or-new')).toBeNull()
    })

    it('org admin passes for their org', () => {
      expect(assertOrganizationAccess(orgAdminA, ORG_A)).toBeNull()
    })

    it('location member passes for their org (membership tier)', () => {
      expect(assertOrganizationAccess(memberA, ORG_A)).toBeNull()
    })

    it('403 for a foreign org (org admin AND member AND outsider)', async () => {
      for (const user of [orgAdminA, memberA, outsider]) {
        const r = assertOrganizationAccess(user, ORG_B)
        expect(r.status).toBe(403)
        const body = await r.json()
        expect(body.error).toMatch(/Forbidden/)
      }
    })

    it('org admin of an org with ZERO locations still passes via orgAdminOrgIds', () => {
      // getCurrentUser puts admin orgs into organizationsById too, but
      // the guard must not depend on that redundancy.
      const zeroLocAdmin = {
        id: 'z1', isMaster: false, organizationsById: {}, orgAdminOrgIds: [ORG_A],
      }
      expect(assertOrganizationAccess(zeroLocAdmin, ORG_A)).toBeNull()
    })
  })

  describe('assertOrganizationAccessOr404', () => {
    it('401 for a null user', async () => {
      const r = assertOrganizationAccessOr404(null, ORG_A)
      expect(r.status).toBe(401)
    })

    it('null orgId passes through', () => {
      expect(assertOrganizationAccessOr404(memberA, null)).toBeNull()
    })

    it('master / org admin / member pass for a reachable org', () => {
      expect(assertOrganizationAccessOr404(master, ORG_B)).toBeNull()
      expect(assertOrganizationAccessOr404(orgAdminA, ORG_A)).toBeNull()
      expect(assertOrganizationAccessOr404(memberA, ORG_A)).toBeNull()
    })

    it('returns 404 (NOT 403) for a foreign org — indistinguishable from missing', async () => {
      const r = assertOrganizationAccessOr404(memberA, ORG_B)
      expect(r.status).toBe(404)
      expect(await r.json()).toEqual({ success: false, error: 'Not found' })
    })
  })

  describe('assertOrganizationAdmin', () => {
    it('401 for a null user', async () => {
      const r = assertOrganizationAdmin(null, ORG_A)
      expect(r.status).toBe(401)
    })

    it('master passes for any org', () => {
      expect(assertOrganizationAdmin(master, ORG_A)).toBeNull()
      expect(assertOrganizationAdmin(master, 'org-anything')).toBeNull()
    })

    it('org admin passes for their org only', async () => {
      expect(assertOrganizationAdmin(orgAdminA, ORG_A)).toBeNull()
      const r = assertOrganizationAdmin(orgAdminA, ORG_B)
      expect(r.status).toBe(403)
    })

    it('403 for a mere location member — membership is NOT management', async () => {
      const r = assertOrganizationAdmin(memberA, ORG_A)
      expect(r.status).toBe(403)
      const body = await r.json()
      expect(body.error).toMatch(/Master or organization admin/)
    })

    it('403 for an outsider', async () => {
      const r = assertOrganizationAdmin(outsider, ORG_A)
      expect(r.status).toBe(403)
    })

    it('null orgId does NOT pass for non-masters (org-less resources are master-only)', async () => {
      const r = assertOrganizationAdmin(orgAdminA, null)
      expect(r.status).toBe(403)
      expect(assertOrganizationAdmin(master, null)).toBeNull()
    })
  })
})

// ─── getOwnerOrganizationIds (mig 106 helper + SAAS-4 admin orgs) ───────

describe('getOwnerOrganizationIds', () => {
  it('returns [] for null user', () => {
    expect(getOwnerOrganizationIds(null)).toEqual([])
  })

  it('maps owner-role locations to their orgs (pre-SAAS-4 behaviour intact)', () => {
    expect(getOwnerOrganizationIds({
      rolesByLocation: { 'loc-a': 'owner', 'loc-b': 'staff' },
      locations: [
        { id: 'loc-a', organization_id: 'org-a' },
        { id: 'loc-b', organization_id: 'org-b' },
      ],
    })).toEqual(['org-a'])
  })

  it('includes org-admin orgs (SAAS-4) and dedupes against owner-derived orgs', () => {
    expect(getOwnerOrganizationIds({
      rolesByLocation: { 'loc-a': 'owner' },
      locations: [{ id: 'loc-a', organization_id: 'org-a' }],
      orgAdminOrgIds: ['org-a', 'org-c'],
    })).toEqual(['org-a', 'org-c'])
  })

  it('org admin of an org with zero active locations still gets the org id', () => {
    expect(getOwnerOrganizationIds({
      rolesByLocation: {},
      locations: [],
      orgAdminOrgIds: ['org-empty'],
    })).toEqual(['org-empty'])
  })

  it('ROLLOUT SAFETY: user without the orgAdminOrgIds field behaves exactly as before', () => {
    expect(getOwnerOrganizationIds({
      rolesByLocation: { 'loc-a': 'manager' },
      locations: [{ id: 'loc-a', organization_id: 'org-a' }],
    })).toEqual([])
  })
})

// ─── requireInboxPermission (INBOX-PERM.1) ──────────────────────────────
// Channel-permission guard for the unified-inbox conversation routes.
// Service-role routes get NO RLS, so this is the ONLY thing standing
// between an authenticated-but-unpermissioned staff user and reading /
// sending on a channel that's toggled off for them.

describe('requireInboxPermission', () => {
  // staff with an explicit per-user override — tier 2 wins, so these
  // fixtures exercise the REAL resolver, no permission mocking.
  const staffWith = (perms) => ({
    role: 'staff',
    activeLocation: { id: 'loc-1', features: {} },
    activeAssignment: { permissions: perms },
    locations: [{ id: 'loc-1' }],
  })

  it('401s a null user (same contract as assertLocationAccess)', async () => {
    const r = requireInboxPermission(null, 'wa')
    expect(r.status).toBe(401)
    expect((await r.json()).success).toBe(false)
  })

  it('403s a user without the whatsapp permission on the wa channel', async () => {
    const r = requireInboxPermission(staffWith({ whatsapp: false }), 'wa')
    expect(r.status).toBe(403)
    expect((await r.json()).success).toBe(false)
  })

  it('passes (null) a user holding the whatsapp permission on the wa channel', () => {
    expect(requireInboxPermission(staffWith({ whatsapp: true }), 'wa')).toBeNull()
  })

  it('ig still rides the whatsapp key — there is no Instagram permission key to point it at', () => {
    expect(requireInboxPermission(staffWith({ whatsapp: true }), 'ig')).toBeNull()
    expect(requireInboxPermission(staffWith({ whatsapp: false }), 'ig')?.status).toBe(403)
  })

  // INBOX-PERM.2 — the live bypass. `em` used to resolve against `whatsapp`,
  // so a coach with the WhatsApp inbox on could read and SEND the studio's
  // email through the legacy /api/email/conversations* routes without holding
  // `email_inbox` or a single email_mailbox_access grant. Both directions are
  // asserted: holding whatsapp must NOT open email, and holding email_inbox
  // must open it without whatsapp.
  it('em rides the email_inbox key — whatsapp alone does NOT open the email channel', () => {
    expect(requireInboxPermission(staffWith({ whatsapp: true, email_inbox: false }), 'em')?.status).toBe(403)
    expect(requireInboxPermission(staffWith({ whatsapp: false, email_inbox: true }), 'em')).toBeNull()
  })

  it('the wa channel is unaffected by the email key', () => {
    expect(requireInboxPermission(staffWith({ whatsapp: true, email_inbox: false }), 'wa')).toBeNull()
    expect(requireInboxPermission(staffWith({ whatsapp: false, email_inbox: true }), 'wa')?.status).toBe(403)
  })

  it('fails CLOSED on an unknown channel — even for master', () => {
    const master = { role: 'master', activeLocation: { id: 'loc-1', features: {} }, activeAssignment: null }
    expect(requireInboxPermission(master, 'sms')?.status).toBe(403)
    expect(requireInboxPermission(master, undefined)?.status).toBe(403)
  })
})

// ─── hasRoleAtLocation (LOCFIX-ROLEGATE.1) ──────────────────────────────
// The predicate behind the last of the active-role-vs-target class. Routes
// that write to a PATH-PARAM location used to ask
// `MANAGER_ROLES.includes(user.role)` — but `user.role` resolves at the
// caller's ACTIVE location (with the highest-role-anywhere fallback above),
// so a manager at Stillorgan who is plain staff at Hatch passed it while
// acting on Hatch. This asks the question about the TARGET.
//
// It is a predicate rather than a guard on purpose: the seven call sites keep
// three different 403 messages between them, and two different role tiers
// (MANAGER_ROLES for holidays/channels; ['master','owner','manager'] — no
// head_coach — for the money-adjacent stripe-connect routes).

describe('hasRoleAtLocation', () => {
  const A = 'loc-a'
  const B = 'loc-b'
  const MANAGER_ROLES = ['master', 'owner', 'manager', 'head_coach']
  const MONEY_ROLES = ['master', 'owner', 'manager']

  // The audit cast: manager at their ACTIVE studio A, plain staff at B.
  // `role` is what the OLD checks read — it must not be consulted.
  const managerAStaffB = {
    role: 'manager', profileRole: 'manager', isMaster: false,
    activeLocation: { id: A },
    rolesByLocation: { [A]: 'manager', [B]: 'staff' },
  }

  it('answers about the TARGET, not the active location', () => {
    expect(hasRoleAtLocation(managerAStaffB, A, MANAGER_ROLES)).toBe(true)
    expect(hasRoleAtLocation(managerAStaffB, B, MANAGER_ROLES)).toBe(false)
  })

  it('reads the per-location role even when the active-location role is lower', () => {
    const staffAManagerB = { role: 'staff', profileRole: 'staff', rolesByLocation: { [A]: 'staff', [B]: 'manager' } }
    expect(hasRoleAtLocation(staffAManagerB, B, MANAGER_ROLES)).toBe(true)
    expect(hasRoleAtLocation(staffAManagerB, A, MANAGER_ROLES)).toBe(false)
  })

  // THE TWO TIERS. The same person, the same target, two different answers —
  // this is what stops the stripe-connect routes being widened by accident.
  it('separates the two tiers: head_coach passes MANAGER_ROLES and fails the money list', () => {
    const headCoachB = { role: 'staff', profileRole: 'staff', rolesByLocation: { [B]: 'head_coach' } }
    expect(hasRoleAtLocation(headCoachB, B, MANAGER_ROLES)).toBe(true)
    expect(hasRoleAtLocation(headCoachB, B, MONEY_ROLES)).toBe(false)
  })

  // The master bypass reads profileRole — the estate role on `profiles` —
  // NOT user.role, which can read 'master' by the active/fallback resolver.
  // Masters carry no rolesByLocation entries at all, so nothing else can
  // carry them.
  it('a master passes on profileRole alone, with no per-location rows', () => {
    const master = { role: 'master', profileRole: 'master', isMaster: true, rolesByLocation: {} }
    expect(hasRoleAtLocation(master, A, MANAGER_ROLES)).toBe(true)
    expect(hasRoleAtLocation(master, B, MONEY_ROLES)).toBe(true)
  })

  it('does NOT bypass on user.role === "master" when profileRole is not master', () => {
    // The fallback resolver can hand `role` a value the caller does not hold
    // at the target. Only profiles.role may bypass the per-location check.
    const fake = { role: 'master', isMaster: true, profileRole: 'manager', rolesByLocation: { [B]: 'staff' } }
    expect(hasRoleAtLocation(fake, B, MANAGER_ROLES)).toBe(false)
    expect(hasRoleAtLocation(fake, B, MONEY_ROLES)).toBe(false)
  })

  it('does NOT let an estate-level owner/manager profileRole stand in for a per-location role', () => {
    const ownerElsewhere = { role: 'owner', profileRole: 'owner', rolesByLocation: { [A]: 'owner' } }
    expect(hasRoleAtLocation(ownerElsewhere, B, MANAGER_ROLES)).toBe(false)
  })

  it('fails CLOSED on a null user, a missing target, or an empty role map', () => {
    expect(hasRoleAtLocation(null, A, MANAGER_ROLES)).toBe(false)
    expect(hasRoleAtLocation(undefined, A, MANAGER_ROLES)).toBe(false)
    expect(hasRoleAtLocation(managerAStaffB, null, MANAGER_ROLES)).toBe(false)
    expect(hasRoleAtLocation(managerAStaffB, undefined, MANAGER_ROLES)).toBe(false)
    expect(hasRoleAtLocation(managerAStaffB, '', MANAGER_ROLES)).toBe(false)
    expect(hasRoleAtLocation({ profileRole: 'manager' }, A, MANAGER_ROLES)).toBe(false)
  })

  // A null target passing would be the difference between "no location
  // claimed" (assertLocationAccess's meaning) and "cannot judge the role" —
  // and here the second reading is the only safe one.
  it('a null target does NOT pass even for a master-less caller with a wide role map', () => {
    expect(hasRoleAtLocation({ profileRole: 'owner', rolesByLocation: { [A]: 'owner' } }, null, MANAGER_ROLES)).toBe(false)
  })

  it('fails CLOSED on a missing or empty allowedRoles list', () => {
    expect(hasRoleAtLocation(managerAStaffB, A, undefined)).toBe(false)
    expect(hasRoleAtLocation(managerAStaffB, A, [])).toBe(false)
  })
})
