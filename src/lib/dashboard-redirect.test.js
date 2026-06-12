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

  it('returns null when the user has no dashboard or radar permissions', () => {
    const u = user({
      role: 'owner',  // even owners can be stripped of every dashboard.
      // Radar keys must be explicitly revoked here — they default ON
      // for owners, and SIDEBAR-IA.1 made them landing fallbacks.
      perms: {
        dashboard_personal: false, dashboard_studio: false, dashboard_business: false,
        churn_radar: false, lead_radar: false,
      },
    })
    expect(resolveDashboardTarget(u)).toBe(null)
  })

  // SIDEBAR-IA.1 — the radars live under the dashboard tab strip now,
  // so a user holding ONLY a radar permission must still land somewhere
  // useful when they hit / or /dashboard.
  describe('radar fallbacks', () => {
    const noDashboards = {
      dashboard_personal: false, dashboard_studio: false, dashboard_business: false,
    }

    it('falls back to the churn radar for a churn-radar-only user', () => {
      const u = user({ perms: { ...noDashboards, churn_radar: true, lead_radar: false } })
      expect(resolveDashboardTarget(u)).toBe('/dashboard/churn-radar')
    })

    it('falls back to the lead radar when churn radar is also revoked', () => {
      const u = user({ perms: { ...noDashboards, churn_radar: false, lead_radar: true } })
      expect(resolveDashboardTarget(u)).toBe('/dashboard/lead-radar')
    })

    it('prefers churn radar over lead radar when both are held', () => {
      const u = user({ perms: { ...noDashboards, churn_radar: true, lead_radar: true } })
      expect(resolveDashboardTarget(u)).toBe('/dashboard/churn-radar')
    })

    it('still prefers any real dashboard over the radar fallbacks', () => {
      const u = user({ perms: { ...noDashboards, dashboard_personal: true, churn_radar: true } })
      expect(resolveDashboardTarget(u)).toBe('/dashboard/today')
    })
  })
})
