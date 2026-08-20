// SEC-LIVE-API.1 — unit tests for the /api/live/** gate.
import { describe, it, expect } from 'vitest'
import {
  guardLiveLocation,
  guardLiveSession,
  roleAtLocation,
  LIVE_MUTATION_ROLES,
  LIVE_PERMISSION,
} from './live-access'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const OTHER = 'b0000000-0000-0000-0000-000000000002'

/**
 * A getCurrentUser()-shaped user. `studio` mirrors the per-location override
 * bag: true / false = explicit, null = unset (falls through to the role
 * default, which is FALSE for staff, reception and head_coach).
 */
function userAt(locationId, role, { studio = true, isMaster = false, extra = [] } = {}) {
  return {
    id: 'u1',
    role,
    isMaster,
    locations: [{ id: locationId, features: {} }, ...extra.map((e) => ({ id: e.id, features: {} }))],
    assignmentsByLocation: {
      [locationId]: { role, permissions: studio === null ? {} : { studio_management: studio } },
      ...Object.fromEntries(extra.map((e) => [e.id, { role: e.role, permissions: e.studio === null ? {} : { studio_management: e.studio } }])),
    },
    roleTemplatesByLocation: {},
  }
}

describe('guardLiveLocation — read gate', () => {
  it('401s an anonymous caller', () => {
    const res = guardLiveLocation(null, LOC)
    expect(res?.status).toBe(401)
  })

  it('403s a staffer at another location before any lookup', () => {
    const res = guardLiveLocation(userAt(OTHER, 'owner'), LOC)
    expect(res?.status).toBe(403)
  })

  it('lets a member holding studio_management through', () => {
    expect(guardLiveLocation(userAt(LOC, 'staff', { studio: true }), LOC)).toBeNull()
  })

  // The whole point of the fix: these two are refused the /live PAGE today,
  // and were able to poll the same payload from the API.
  it('403s a head_coach on the role default (studio_management unset)', () => {
    const res = guardLiveLocation(userAt(LOC, 'head_coach', { studio: null }), LOC)
    expect(res?.status).toBe(403)
  })

  it('403s a manager with an explicit studio_management: false', () => {
    const res = guardLiveLocation(userAt(LOC, 'manager', { studio: false }), LOC)
    expect(res?.status).toBe(403)
  })

  it('lets master through without a per-location assignment', () => {
    expect(guardLiveLocation({ id: 'm', role: 'master', isMaster: true }, LOC)).toBeNull()
  })

  it('honours the tier-1 location feature gate, even for master', () => {
    const master = { id: 'm', role: 'master', isMaster: true, locations: [{ id: LOC, features: { [LIVE_PERMISSION]: false } }], assignmentsByLocation: {} }
    expect(guardLiveLocation(master, LOC)?.status).toBe(403)
  })
})

describe('guardLiveLocation — mutation gate', () => {
  it('403s a permitted staff member who lacks a coach role', () => {
    const res = guardLiveLocation(userAt(LOC, 'staff', { studio: true }), LOC, { roles: LIVE_MUTATION_ROLES })
    expect(res?.status).toBe(403)
  })

  it('allows a head_coach who holds the permission', () => {
    expect(guardLiveLocation(userAt(LOC, 'head_coach', { studio: true }), LOC, { roles: LIVE_MUTATION_ROLES })).toBeNull()
  })

  it('403s a coach role that lacks the permission (the new half of the gate)', () => {
    const res = guardLiveLocation(userAt(LOC, 'head_coach', { studio: null }), LOC, { roles: LIVE_MUTATION_ROLES })
    expect(res?.status).toBe(403)
  })

  // Prod has an account that is head_coach at Stillorgan and owner at Hatch.
  // The role must resolve at the TARGET location, not the active one.
  it('resolves the role at the target location, not the active one', () => {
    const user = userAt(LOC, 'staff', { studio: true, extra: [{ id: OTHER, role: 'owner', studio: true }] })
    user.role = 'owner' // active location is OTHER, so getCurrentUser reports owner
    expect(guardLiveLocation(user, LOC, { roles: LIVE_MUTATION_ROLES })?.status).toBe(403)
    expect(guardLiveLocation(user, OTHER, { roles: LIVE_MUTATION_ROLES })).toBeNull()
  })
})

describe('roleAtLocation', () => {
  it('prefers the per-location assignment over the active-location role', () => {
    const user = userAt(LOC, 'head_coach')
    user.role = 'owner'
    expect(roleAtLocation(user, LOC)).toBe('head_coach')
  })

  it('falls back to user.role when there is no assignment (org-admin synthetic)', () => {
    expect(roleAtLocation({ role: 'owner' }, LOC)).toBe('owner')
  })

  it('reports master as master', () => {
    expect(roleAtLocation({ role: 'master', isMaster: true }, LOC)).toBe('master')
  })
})

describe('guardLiveSession — no existence oracle', () => {
  const missing = guardLiveSession(userAt(LOC, 'head_coach'), null)
  const foreign = guardLiveSession(userAt(LOC, 'head_coach'), { location_id: OTHER })
  const unpermitted = guardLiveSession(userAt(LOC, 'head_coach', { studio: null }), { location_id: LOC })

  it('404s a session id that does not exist', () => {
    expect(missing?.status).toBe(404)
  })

  it('404s — not 403s — a real session at a location you cannot reach', () => {
    expect(foreign?.status).toBe(404)
  })

  it('404s a real session at your own location when you lack the permission', () => {
    expect(unpermitted?.status).toBe(404)
  })

  it('returns a byte-identical body for missing, foreign and unpermitted', async () => {
    const bodies = await Promise.all([missing, foreign, unpermitted].map((r) => r.text()))
    expect(new Set(bodies).size).toBe(1)
  })

  it('lets a permitted coach at the session location through', () => {
    expect(guardLiveSession(userAt(LOC, 'head_coach'), { location_id: LOC })).toBeNull()
  })
})
