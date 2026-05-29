// hasAnyMobileFeature contract tests.
//
// This helper drives the empty-state on the mobile Home tab — if it
// returns false, the user sees the "Mobile features off — ask an
// admin" nudge instead of any dashboard. Subtle to get wrong:
//
//   • Mobile features live under permissions.mobile.<key>.
//   • The three dashboard tiers (personal / studio / business) live
//     at the TOP level of the same blob (cross-platform — same admin
//     toggle controls web sidebar AND mobile Home).
//
// Walking only one of the two key spaces produces a false negative:
// a user with every .mobile.* key off but a dashboard_* still on
// would see the empty state despite being entitled to the
// dashboard. This file pins both branches so a future refactor
// can't silently regress to the one-walk version.
//
// Tests run in vitest's Node environment — permissions.js is pure
// JS with no React-Native imports, so no RN runtime is required.

import { describe, it, expect } from 'vitest'
import { hasAnyMobileFeature, canMobile } from './permissions.js'
import {
  MOBILE_PERMISSION_KEYS,
  CROSS_PLATFORM_DASHBOARD_KEYS,
} from '../../shared/permissions.js'

// Construct a per-user permissions blob that explicitly denies every
// mobile and every dashboard key — the most aggressive "off" baseline
// possible at tier 2. Built from the canonical key lists so adding a
// new feature in shared/permissions.js keeps the baseline complete.
const allOffPermissions = () => ({
  ...Object.fromEntries(CROSS_PLATFORM_DASHBOARD_KEYS.map(k => [k, false])),
  mobile: Object.fromEntries(MOBILE_PERMISSION_KEYS.map(k => [k, false])),
})

// No tier-1 denials. features: {} means no key is explicitly disabled
// at the location, so tier 1 never blocks.
const openLocation = (permissions) => ({ features: {}, permissions })

describe('hasAnyMobileFeature', () => {
  it('returns false defensively for a null profile', () => {
    expect(hasAnyMobileFeature(null)).toBe(false)
    expect(hasAnyMobileFeature(undefined)).toBe(false)
  })

  it('returns false when every mobile AND every dashboard key is off', () => {
    // Baseline: explicit-false everywhere via tier 2. Role default
    // never gets a chance to flip the result.
    expect(hasAnyMobileFeature(
      { role: 'staff' },
      openLocation(allOffPermissions())
    )).toBe(false)
  })

  it('returns true when at least one .mobile.* key is enabled (regression check)', () => {
    // Existing behaviour before the dashboard branch existed —
    // a single mobile feature on is enough.
    const perms = allOffPermissions()
    perms.mobile.schedule = true
    expect(hasAnyMobileFeature(
      { role: 'staff' },
      openLocation(perms)
    )).toBe(true)
  })

  it('returns true when one dashboard_* key is on and every .mobile.* key is off (the fix)', () => {
    // The bug: pre-fix this returned false because only the .mobile.*
    // bag was walked. A user with all mobile screens disabled but
    // entitled to at least one dashboard tier should still land on
    // the dashboard, not the empty state.
    const perms = allOffPermissions()
    perms.dashboard_personal = true
    expect(hasAnyMobileFeature(
      { role: 'staff' },
      openLocation(perms)
    )).toBe(true)
  })

  it('honours the location feature gate on dashboard keys (tier 1 wins)', () => {
    // Per-user override enables the dashboard, but the location
    // disables it at tier 1. Result: false. Tier 1 trumps tier 2
    // for all keys including dashboards — same semantics as
    // canDashboard alone.
    const perms = allOffPermissions()
    perms.dashboard_personal = true
    const location = {
      features: { dashboard_personal: false },
      permissions: perms,
    }
    expect(hasAnyMobileFeature({ role: 'staff' }, location)).toBe(false)
  })

  it('still returns true for master because notify_* keys are tier-1-exempt and master bypasses 2+3', () => {
    // Belt-and-braces — master is a special role: notify_* keys are
    // exempt from location-gating (personal comms toggles), so once
    // tier 1 passes for them, master bypasses tiers 2+3 → true.
    // hasAnyMobileFeature should therefore short-circuit on the
    // first notify_* via the mobile-keys walk, before ever reaching
    // the new dashboard branch. This locks in that master is never
    // shown the empty state in production.
    const location = {
      features: {
        // Disable every gateable mobile feature at the location.
        // notify_* keys are exempt from this gate (see
        // shared/permissions.js → isFeatureEnabledAtLocation).
        schedule: false, pipeline: false, whatsapp: false,
        tasks: false, bookings: false, time_off: false, assistant: false,
        studio_management: false,
        dashboard_personal: false, dashboard_studio: false, dashboard_business: false,
      },
      permissions: { mobile: {} },
    }
    expect(hasAnyMobileFeature({ role: 'master' }, location)).toBe(true)
  })
})


describe('canMobile — cross-platform keys (studio_management)', () => {
  // Regression: studio_management is a CROSS_PLATFORM (top-level) key.
  // A head_coach with it enabled for the web sidebar (top-level true)
  // must also get the mobile Studio tab. Before the fix, canMobile read
  // only the .mobile namespace + mobile defaults (where the key doesn't
  // exist), so it returned false for every non-master role.
  it('grants the Studio tab to a head_coach with top-level studio_management on', () => {
    const location = { features: {}, permissions: { studio_management: true, mobile: {} } }
    expect(canMobile({ role: 'head_coach' }, 'studio_management', location)).toBe(true)
  })

  it('withholds it from a head_coach when the top-level key is off (role default)', () => {
    const location = { features: {}, permissions: { studio_management: false, mobile: {} } }
    expect(canMobile({ role: 'head_coach' }, 'studio_management', location)).toBe(false)
  })

  it('honours the location feature gate (tier 1) even if the user key is on', () => {
    const location = { features: { studio_management: false }, permissions: { studio_management: true, mobile: {} } }
    expect(canMobile({ role: 'head_coach' }, 'studio_management', location)).toBe(false)
  })

  it('master sees it regardless (short-circuit)', () => {
    const location = { features: {}, permissions: { mobile: {} } }
    expect(canMobile({ role: 'master' }, 'studio_management', location)).toBe(true)
  })
})
