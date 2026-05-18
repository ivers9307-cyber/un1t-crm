// PERF.1 — tests for the dashboard-redirect resolver. Covers the
// three resolution branches (preference, smart default, none) and
// the user-permission revocation edge case.

import { describe, it, expect } from 'vitest'
import { resolveDashboardTarget } from './dashboard-redirect.js'

// Stable user shape factory. Two buckets matter here:
//   - hasPermission() reads `user.activeAssignment.permissions`
//     (per-location user overrides — mig 058).
//   - resolveLandingPreference() reads `user.permissions.landing_preference`
//     (top-level preference, profile-wide).
// Each test sets only what it needs; the rest of the resolver
// (master bypass, role defaults) falls through accordingly.
function user({ role = 'owner', perms = {}, prefs = {} } = {}) {
  return {
    id: 'u1',
    role,
    activeLocation: { id: 'loc1', features: {} },
    activeAssignment: { permissions: { ...perms } },
    permissions: { ...prefs },
  }
}

describe('resolveDashboardTarget', () => {
  it('returns null for missing user', () => {
    expect(resolveDashboardTarget(null)).toBe(null)
    expect(resolveDashboardTarget(undefined)).toBe(null)
  })

  it('honours an explicit landing_preference when the user has the matching permission', () => {
    const u = user({
      perms: { dashboard_personal: true, dashboard_studio: true, dashboard_business: true },
      prefs: { landing_preference: 'studio' },
    })
    expect(resolveDashboardTarget(u)).toBe('/dashboard/studio')
  })

  it('falls through to smart-default when preference permission was revoked', () => {
    const u = user({
      perms: { dashboard_personal: true, dashboard_studio: false, dashboard_business: false },
      prefs: { landing_preference: 'business' },  // no permission for business
    })
    // No business → no studio → personal is only one left.
    expect(resolveDashboardTarget(u)).toBe('/dashboard/today')
  })

  it('falls through to smart-default for landing_preference = auto', () => {
    const u = user({
      perms: { dashboard_personal: true, dashboard_studio: true, dashboard_business: true },
      prefs: { landing_preference: 'auto' },
    })
    // No preference honoured → smart-default picks the most-aggregated.
    expect(resolveDashboardTarget(u)).toBe('/dashboard/business')
  })

  it('smart-default prefers Business → Studio → Today', () => {
    expect(resolveDashboardTarget(user({
      perms: { dashboard_personal: true, dashboard_studio: true, dashboard_business: true },
    }))).toBe('/dashboard/business')
    expect(resolveDashboardTarget(user({
      perms: { dashboard_personal: true, dashboard_studio: true, dashboard_business: false },
    }))).toBe('/dashboard/studio')
    expect(resolveDashboardTarget(user({
      perms: { dashboard_personal: true, dashboard_studio: false, dashboard_business: false },
    }))).toBe('/dashboard/today')
  })

  it('returns null when the user has no dashboard permissions', () => {
    const u = user({
      role: 'owner',  // even owners can be stripped of every dashboard
      perms: { dashboard_personal: false, dashboard_studio: false, dashboard_business: false },
    })
    expect(resolveDashboardTarget(u)).toBe(null)
  })
})
