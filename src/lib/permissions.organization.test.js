// ZOOMOPS follow-up — org-scoped permission resolution.
//
// The distinction under test is the one that made the Zoom run route wrong:
// which organisation a user can ACT IN is a fact about their assignments,
// while `activeLocation` / `activeOrganization` / `role` / `activeAssignment`
// are session state that mirrors whichever location is selected in the
// browser right now. A gate built on the latter both locks out legitimate
// staff (usability) and, if naively loosened, grants a capability earned at
// one org to an operation belonging to another (access control).
import { describe, it, expect } from 'vitest'
import { hasPermissionInOrganization } from './permissions'

// Owner + master only in shared/permissions.js — the same key the Zoom
// destructive run gates on, so these tests exercise a real role split
// rather than a synthetic one.
const KEY = 'integrations_zoom_manage'

const ORG_SYNC = 'org-un1t'
const ORG_OTHER = 'org-ccf'

/**
 * Build a user shaped the way getCurrentUser() returns one.
 *
 * `at` is the membership fact: { [locationId]: { org, role, permissions? } }.
 * `activeLocationId` is the session state — deliberately independent, so
 * every test can pull the two apart.
 */
function user({ at = {}, activeLocationId = null, master = false } = {}) {
  const locations = Object.entries(at).map(([id, v]) => ({ id, organization_id: v.org }))
  const assignmentsByLocation = Object.fromEntries(
    Object.entries(at).map(([id, v]) => [id, { role: v.role, permissions: v.permissions || {} }])
  )
  const activeLocation = activeLocationId
    ? locations.find((l) => l.id === activeLocationId) || null
    : null
  return {
    isMaster: master,
    // Active-location role, exactly as getCurrentUser resolves it.
    role: master ? 'master' : (assignmentsByLocation[activeLocationId]?.role || 'staff'),
    locations,
    assignmentsByLocation,
    activeLocation,
    activeAssignment: activeLocationId ? assignmentsByLocation[activeLocationId] || null : null,
    roleTemplatesByLocation: {},
  }
}

describe('hasPermissionInOrganization', () => {
  it('refuses a null user and a null organisation', () => {
    expect(hasPermissionInOrganization(null, ORG_SYNC, KEY)).toBe(false)
    expect(hasPermissionInOrganization(user({ at: { 'loc-a': { org: ORG_SYNC, role: 'owner' } } }), null, KEY)).toBe(false)
  })

  it('grants when the user holds the permission at a location in that organisation', () => {
    const u = user({
      at: { 'loc-a': { org: ORG_SYNC, role: 'owner' } },
      activeLocationId: 'loc-a',
    })
    expect(hasPermissionInOrganization(u, ORG_SYNC, KEY)).toBe(true)
  })

  // THE USABILITY BUG. Their owner role inside the synced org is a fact about
  // their assignments; having a CCF Autos location selected in the browser
  // must not revoke it.
  it('grants regardless of which location is currently active', () => {
    const u = user({
      at: {
        'loc-un1t': { org: ORG_SYNC, role: 'owner' },
        'loc-ccf': { org: ORG_OTHER, role: 'staff' },
      },
      activeLocationId: 'loc-ccf',
    })
    expect(hasPermissionInOrganization(u, ORG_SYNC, KEY)).toBe(true)
  })

  // THE ACCESS-CONTROL HOLE a naive fix opens. This user IS a member of the
  // synced org, and `hasPermission()` would say true because it resolves at
  // their active CCF Autos location where they are owner — but the only role
  // they hold inside the synced org is staff, so they may not act there.
  it('refuses a capability earned in a DIFFERENT organisation', () => {
    const u = user({
      at: {
        'loc-un1t': { org: ORG_SYNC, role: 'staff' },
        'loc-ccf': { org: ORG_OTHER, role: 'owner' },
      },
      activeLocationId: 'loc-ccf',
    })
    expect(hasPermissionInOrganization(u, ORG_SYNC, KEY)).toBe(false)
  })

  it('refuses a member of the organisation who lacks the permission there', () => {
    const u = user({
      at: { 'loc-un1t': { org: ORG_SYNC, role: 'staff' } },
      activeLocationId: 'loc-un1t',
    })
    expect(hasPermissionInOrganization(u, ORG_SYNC, KEY)).toBe(false)
  })

  it('refuses a user with no relationship to the organisation at all', () => {
    const u = user({
      at: { 'loc-ccf': { org: ORG_OTHER, role: 'owner' } },
      activeLocationId: 'loc-ccf',
    })
    expect(hasPermissionInOrganization(u, ORG_SYNC, KEY)).toBe(false)
  })

  it('grants to master', () => {
    expect(hasPermissionInOrganization(user({ master: true }), ORG_SYNC, KEY)).toBe(true)
  })

  // Proves the scan goes through the real tiered resolver at the TARGET
  // location rather than re-implementing a role comparison: a per-location
  // override lifts a staffer who would otherwise be refused.
  it('honours a per-location override at the target location', () => {
    const u = user({
      at: {
        'loc-un1t': { org: ORG_SYNC, role: 'staff', permissions: { [KEY]: true } },
        'loc-ccf': { org: ORG_OTHER, role: 'staff' },
      },
      activeLocationId: 'loc-ccf',
    })
    expect(hasPermissionInOrganization(u, ORG_SYNC, KEY)).toBe(true)
  })
})
