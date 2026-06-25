import { describe, it, expect } from 'vitest'
import {
  buildRolesByLocation,
  resolveActiveLocationRole,
  assertLocationAccess,
  assertLocationAccessOr404,
  getUserLocationIds,
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
