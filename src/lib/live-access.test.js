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

  // These two are refused the /live PAGE and were able to poll the same
  // payload from the API. NOTE (SEC-LIVE-API.2): the first case is the
  // RESOLVER's behaviour with no role template — at Stillorgan a template row
  // grants head_coach `studio_management`, so no real head_coach there is in
  // this state. The second case is the one prod actually has: exactly one
  // account, a manager with an explicit false. `roleTemplatesByLocation: {}`
  // in the fixture is what makes the first case reachable at all.
  it('403s a head_coach on the role default (studio_management unset, no template)', () => {
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

  // SEC-LIVE-API.2 — the correction that halved-and-then-some the measured
  // blast radius. `location_role_permissions` (tier 2.5) is consulted BEFORE
  // the code role default, and Stillorgan grants head_coach + staff
  // `studio_management` there. Reasoning from the defaults alone reported 6
  // locked-out accounts when the real number is 1.
  it('lets the role template grant the permission over a false code default', () => {
    const user = userAt(LOC, 'head_coach', { studio: null })
    user.roleTemplatesByLocation = { [LOC]: { [LIVE_PERMISSION]: true } }
    expect(guardLiveLocation(user, LOC)).toBeNull()
  })

  it('still lets an explicit per-user false beat a permissive role template', () => {
    const user = userAt(LOC, 'manager', { studio: false })
    user.roleTemplatesByLocation = { [LOC]: { [LIVE_PERMISSION]: true } }
    expect(guardLiveLocation(user, LOC)?.status).toBe(403)
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

// SEC-LIVE-API.2 — the mutation role must resolve at the SESSION's location,
// not at the caller-chosen active one. Without this the route's only role
// check was its pre-lookup test against `user.role`, so head_coach@L2 +
// staff@L1 could send `x-active-location: L2` and end a session on L1.
describe('guardLiveSession — mutation role resolves at the session location', () => {
  function multiLocationUser() {
    // staff at LOC (holds studio_management there), head_coach at OTHER.
    const user = userAt(LOC, 'staff', {
      studio: true,
      extra: [{ id: OTHER, role: 'head_coach', studio: true }],
    })
    user.role = 'head_coach' // active location is OTHER
    return user
  }

  it('404s the borrowed-coach-role case at the session location', () => {
    const res = guardLiveSession(multiLocationUser(), { location_id: LOC }, { roles: LIVE_MUTATION_ROLES })
    expect(res?.status).toBe(404)
  })

  it('allows the same caller at the location where they DO hold the role', () => {
    expect(
      guardLiveSession(multiLocationUser(), { location_id: OTHER }, { roles: LIVE_MUTATION_ROLES }),
    ).toBeNull()
  })

  it('refuses a wrong role with the same body as a missing id — still no oracle', async () => {
    const missing = guardLiveSession(multiLocationUser(), null, { roles: LIVE_MUTATION_ROLES })
    const wrongRole = guardLiveSession(multiLocationUser(), { location_id: LOC }, { roles: LIVE_MUTATION_ROLES })
    const bodies = await Promise.all([missing, wrongRole].map((r) => r.text()))
    expect(missing.status).toBe(wrongRole.status)
    expect(new Set(bodies).size).toBe(1)
  })

  it('leaves master alone', () => {
    const master = { id: 'm', role: 'master', isMaster: true }
    expect(guardLiveSession(master, { location_id: LOC }, { roles: LIVE_MUTATION_ROLES })).toBeNull()
  })

  it('is a no-op when no roles are passed (read callers keep their shape)', () => {
    expect(guardLiveSession(multiLocationUser(), { location_id: LOC })).toBeNull()
  })
})
