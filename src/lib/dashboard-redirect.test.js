// PERF.1 — tests for the dashboard-redirect resolver. Covers the
// three resolution branches (preference, smart default, none) and
// the user-permission revocation edge case.

import { describe, it, expect } from 'vitest'
import { resolveDashboardTarget, resolveLandingTarget } from './dashboard-redirect.js'

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
      // Radar + engagement + ads keys must be explicitly revoked here — they
      // default ON for owners, and are landing fallbacks (SIDEBAR-IA.1 / P2-7 / ADS-REPORT).
      perms: {
        dashboard_personal: false, dashboard_studio: false, dashboard_business: false,
        churn_radar: false, lead_radar: false, engagement_analytics: false,
        dashboard_ads: false,
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

// REPSET-ACCOUNT.1 — the ACCOUNT-tier landing decision. Routes a
// multi-studio owner (or master) to the org portfolio; everyone else
// falls through (null) to the existing per-studio behaviour.
describe('resolveLandingTarget', () => {
  // getOwnerOrganizationIds reads rolesByLocation + locations, so build
  // the real user shape.
  function acct({
    role = 'owner', isMaster = false, activeOrgId = 'org-a', locations = [], rolesByLocation = {},
  } = {}) {
    return {
      role, isMaster,
      activeOrganization: activeOrgId ? { id: activeOrgId } : null,
      rolesByLocation, locations,
    }
  }

  it('returns null for a missing user (caller → /login)', () => {
    expect(resolveLandingTarget(null)).toBe(null)
    expect(resolveLandingTarget(undefined)).toBe(null)
  })

  it('master with an active org lands on the portfolio', () => {
    expect(resolveLandingTarget(acct({ role: 'master', isMaster: true, activeOrgId: 'org-a' }))).toBe('/portfolio')
  })

  it('master with NO active org falls through (existing behaviour)', () => {
    expect(resolveLandingTarget(acct({ role: 'master', isMaster: true, activeOrgId: null }))).toBe(null)
  })

  it('owner of the active org with ≥2 studios → portfolio', () => {
    const u = acct({
      role: 'owner', activeOrgId: 'org-a',
      rolesByLocation: { loc1: 'owner', loc2: 'owner' },
      locations: [
        { id: 'loc1', organization_id: 'org-a' },
        { id: 'loc2', organization_id: 'org-a' },
      ],
    })
    expect(resolveLandingTarget(u)).toBe('/portfolio')
  })

  it('single-studio owner → null (studio dashboard, UNCHANGED)', () => {
    const u = acct({
      role: 'owner', activeOrgId: 'org-a',
      rolesByLocation: { loc1: 'owner' },
      locations: [{ id: 'loc1', organization_id: 'org-a' }],
    })
    expect(resolveLandingTarget(u)).toBe(null)
  })

  it('only counts studios WITHIN the active org (a second-org studio does not tip it over)', () => {
    const u = acct({
      role: 'owner', activeOrgId: 'org-a',
      rolesByLocation: { loc1: 'owner', loc2: 'owner' },
      locations: [
        { id: 'loc1', organization_id: 'org-a' },
        { id: 'loc2', organization_id: 'org-b' }, // different org
      ],
    })
    expect(resolveLandingTarget(u)).toBe(null)
  })

  it('a multi-studio MANAGER (not an org owner) falls through — not account-tier', () => {
    const u = acct({
      role: 'manager', activeOrgId: 'org-a',
      rolesByLocation: { loc1: 'manager', loc2: 'manager' },
      locations: [
        { id: 'loc1', organization_id: 'org-a' },
        { id: 'loc2', organization_id: 'org-a' },
      ],
    })
    expect(resolveLandingTarget(u)).toBe(null)
  })

  it('no active org → null (fail-safe / ambiguity)', () => {
    const u = acct({ role: 'owner', activeOrgId: null })
    expect(resolveLandingTarget(u)).toBe(null)
  })

  it('a malformed user degrades to null instead of throwing (fail-safe)', () => {
    // locations is not an array — the internal filter would throw if
    // unguarded; the try/catch returns null.
    const u = { role: 'owner', activeOrganization: { id: 'org-a' }, rolesByLocation: { loc1: 'owner' }, locations: 'nope' }
    expect(resolveLandingTarget(u)).toBe(null)
  })
})
