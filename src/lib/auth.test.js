import { describe, it, expect } from 'vitest'
import { buildRolesByLocation, resolveActiveLocationRole } from './auth.js'

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
