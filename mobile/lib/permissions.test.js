// hasAnyMobileFeature contract tests.
//
// This helper drives the empty-state on the mobile Home tab — if it
// returns false, the user sees the "Mobile features off — ask an
// admin" nudge instead of any dashboard. Subtle to get wrong:
//
//   • Mobile features live under permissions.mobile.<key>.
//   • Every CROSS_PLATFORM key (the three dashboard tiers, plus
//     studio_management / class_timer / bookkeeper / email_inbox /
//     device_control…) lives at the TOP level of the same blob — one
//     admin toggle controls the web sidebar AND the mobile surface.
//
// Walking only one of the two key spaces produces a false negative:
// a user with every .mobile.* key off but a top-level key still on
// would see the empty state despite having a navigable tab. The first
// version of this helper walked the mobile keys only; the dashboard
// keys were added next; MOBILEFEAT.1 widened it to every
// cross-platform key, because a head coach whose only entitlement was
// Studio Management got the "ask an admin" nudge on Home while the
// Studio tab sat right there in the bar. This file pins both walks so
// a future refactor can't silently regress to a narrower version.
//
// Tests run in vitest's Node environment — permissions.js is pure
// JS with no React-Native imports, so no RN runtime is required.

import { describe, it, expect } from 'vitest'
import { hasAnyMobileFeature, canMobile } from './permissions.js'
import {
  MOBILE_PERMISSION_KEYS,
  CROSS_PLATFORM_DASHBOARD_KEYS,
  CROSS_PLATFORM_KEYS,
} from 'shared/permissions'

// Construct a per-user permissions blob that explicitly denies every
// mobile key and every cross-platform key — the most aggressive "off"
// baseline possible at tier 2. Built from the canonical key lists so
// adding a new feature in shared/permissions.js keeps the baseline
// complete. It MUST cover every CROSS_PLATFORM key, not just the
// dashboards: class_timer defaults ON for every role, so a baseline
// that forgot it would make the "nothing on" case true by default.
const allOffPermissions = () => ({
  ...Object.fromEntries(CROSS_PLATFORM_KEYS.map(k => [k, false])),
  mobile: Object.fromEntries(MOBILE_PERMISSION_KEYS.map(k => [k, false])),
})

// The cross-platform keys that are NOT dashboard tiers — the ones the
// pre-MOBILEFEAT.1 walk missed. Derived, so the list grows on its own
// (device_control joins it with SONOSMOB.2).
const NON_DASHBOARD_CROSS_PLATFORM_KEYS = CROSS_PLATFORM_KEYS.filter(
  k => !CROSS_PLATFORM_DASHBOARD_KEYS.includes(k),
)

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

describe('hasAnyMobileFeature — every cross-platform key counts (MOBILEFEAT.1)', () => {
  // The gap: studio_management, class_timer, bookkeeper, email_inbox (and
  // device_control once SONOSMOB.2 lands) are top-level keys that open a
  // tab or sub-screen on mobile, but the walk only knew the dashboard
  // tiers. A head coach with ONLY studio_management on had a Studio tab
  // in the bar and the "ask an admin" nudge on Home at the same time.
  it('a head_coach with only studio_management on is not shown the empty state', () => {
    const perms = allOffPermissions()
    perms.studio_management = true
    expect(hasAnyMobileFeature({ role: 'head_coach' }, openLocation(perms))).toBe(true)
  })

  it('the derived list actually contains the keys the old walk missed', () => {
    // Guards the table test below against passing vacuously if the key
    // lists are ever reshaped.
    expect(NON_DASHBOARD_CROSS_PLATFORM_KEYS).toEqual(expect.arrayContaining(['studio_management', 'class_timer']))
  })

  it.each(NON_DASHBOARD_CROSS_PLATFORM_KEYS)(
    'a head_coach with only %s on is not shown the empty state',
    (key) => {
      const perms = allOffPermissions()
      perms[key] = true
      expect(hasAnyMobileFeature({ role: 'head_coach' }, openLocation(perms))).toBe(true)
    },
  )

  it('a head_coach with every mobile AND every cross-platform key off IS shown the empty state', () => {
    // Explicit-false on every key at tier 2, so no role default (class_timer
    // is ON for every role) can leak through.
    expect(hasAnyMobileFeature({ role: 'head_coach' }, openLocation(allOffPermissions()))).toBe(false)
  })

  it('honours the location feature gate on a cross-platform key (tier 1 wins)', () => {
    const perms = allOffPermissions()
    perms.studio_management = true
    const location = { features: { studio_management: false }, permissions: perms }
    expect(hasAnyMobileFeature({ role: 'head_coach' }, location)).toBe(false)
  })

  it('master is never shown the empty state', () => {
    expect(hasAnyMobileFeature({ role: 'master' }, openLocation(allOffPermissions()))).toBe(true)
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

describe('canMobile — cross-platform keys (device_control, SONOSMOB.2)', () => {
  // Regression: device_control is a CROSS_PLATFORM (top-level) key — same
  // shape as studio_management above. If it were ever dropped from
  // CROSS_PLATFORM_KEYS, canMobile would fall to the mobile defaults map,
  // which has no entry for it, so every non-master role would silently
  // get false and the Studio-music tile would just vanish.
  it('grants Studio music control to a head_coach with top-level device_control on', () => {
    const location = { features: {}, permissions: { device_control: true, mobile: {} } }
    expect(canMobile({ role: 'head_coach' }, 'device_control', location)).toBe(true)
  })

  it('withholds it from a head_coach when the top-level key is off (role default)', () => {
    const location = { features: {}, permissions: { device_control: false, mobile: {} } }
    expect(canMobile({ role: 'head_coach' }, 'device_control', location)).toBe(false)
  })

  it('honours the location feature gate (tier 1) even if the user key is on', () => {
    const location = { features: { device_control: false }, permissions: { device_control: true, mobile: {} } }
    expect(canMobile({ role: 'head_coach' }, 'device_control', location)).toBe(false)
  })

  it('master sees it regardless (short-circuit)', () => {
    const location = { features: {}, permissions: { mobile: {} } }
    expect(canMobile({ role: 'master' }, 'device_control', location)).toBe(true)
  })
})

describe('canMobile — staff_management default (STAFF-C3 parity inversion)', () => {
  // The mobile staff-management surface (directory + role/permission
  // editors) is gated by this key. Its role defaults MUST match the
  // pre-C3 hardcoded gate (['master','owner','manager']) so the inversion
  // changes who can be GRANTED/REVOKED the surface, not who sees it by
  // default. A regression here silently shows or hides Staff for a role.
  const roleDefaultLoc = { features: {}, permissions: { mobile: {} } }

  it('defaults ON for master / owner / manager (matches the old role gate)', () => {
    expect(canMobile({ role: 'master' }, 'staff_management', roleDefaultLoc)).toBe(true)
    expect(canMobile({ role: 'owner' }, 'staff_management', roleDefaultLoc)).toBe(true)
    expect(canMobile({ role: 'manager' }, 'staff_management', roleDefaultLoc)).toBe(true)
  })

  it('defaults OFF for head_coach / staff', () => {
    expect(canMobile({ role: 'head_coach' }, 'staff_management', roleDefaultLoc)).toBe(false)
    expect(canMobile({ role: 'staff' }, 'staff_management', roleDefaultLoc)).toBe(false)
  })

  it('is grantable per-user — a head_coach with an explicit override sees it', () => {
    const loc = { features: {}, permissions: { mobile: { staff_management: true } } }
    expect(canMobile({ role: 'head_coach' }, 'staff_management', loc)).toBe(true)
  })

  it('is revocable per-user — a manager with an explicit false loses it', () => {
    const loc = { features: {}, permissions: { mobile: { staff_management: false } } }
    expect(canMobile({ role: 'manager' }, 'staff_management', loc)).toBe(false)
  })

  it('honours the location feature gate (tier 1) when staff_management is disabled at the location', () => {
    const loc = { features: { staff_management: false }, permissions: { mobile: { staff_management: true } } }
    expect(canMobile({ role: 'owner' }, 'staff_management', loc)).toBe(false)
  })
})

describe('canMobile — issue_triage default (W1 parity inversion)', () => {
  // The handler inbox is gated by this key. Defaults must be owner/master
  // only — matching the isHandler gate on every triage route, so granting
  // it to a non-handler role wouldn't actually let them act.
  const roleDefaultLoc = { features: {}, permissions: { mobile: {} } }

  it('defaults ON for master / owner', () => {
    expect(canMobile({ role: 'master' }, 'issue_triage', roleDefaultLoc)).toBe(true)
    expect(canMobile({ role: 'owner' }, 'issue_triage', roleDefaultLoc)).toBe(true)
  })

  it('defaults OFF for manager / head_coach / staff (not handlers)', () => {
    expect(canMobile({ role: 'manager' }, 'issue_triage', roleDefaultLoc)).toBe(false)
    expect(canMobile({ role: 'head_coach' }, 'issue_triage', roleDefaultLoc)).toBe(false)
    expect(canMobile({ role: 'staff' }, 'issue_triage', roleDefaultLoc)).toBe(false)
  })
})

describe('canMobile — contacts default (W1 parity inversion)', () => {
  const roleDefaultLoc = { features: {}, permissions: { mobile: {} } }

  it('defaults ON for every role (mirrors the web contacts list)', () => {
    for (const role of ['master', 'owner', 'manager', 'head_coach', 'staff']) {
      expect(canMobile({ role }, 'contacts', roleDefaultLoc)).toBe(true)
    }
  })

  it('respects a per-user revoke and the location feature gate', () => {
    expect(canMobile({ role: 'staff' }, 'contacts', { features: {}, permissions: { mobile: { contacts: false } } })).toBe(false)
    expect(canMobile({ role: 'owner' }, 'contacts', { features: { contacts: false }, permissions: { mobile: {} } })).toBe(false)
  })
})

describe('canMobile — invoices_inbox default (W2 parity inversion)', () => {
  // Approver inbox — owner/master only, matching the approve/decline
  // route gate (owner-at-location / master).
  const loc = { features: {}, permissions: { mobile: {} } }

  it('defaults ON for master / owner', () => {
    expect(canMobile({ role: 'master' }, 'invoices_inbox', loc)).toBe(true)
    expect(canMobile({ role: 'owner' }, 'invoices_inbox', loc)).toBe(true)
  })

  it('defaults OFF for manager / head_coach / staff', () => {
    expect(canMobile({ role: 'manager' }, 'invoices_inbox', loc)).toBe(false)
    expect(canMobile({ role: 'head_coach' }, 'invoices_inbox', loc)).toBe(false)
    expect(canMobile({ role: 'staff' }, 'invoices_inbox', loc)).toBe(false)
  })
})

describe('canMobile — orders default (W2 parity inversion)', () => {
  // Read-only revenue view. Defaults match the web orders gate
  // (MANAGER_ROLES + hasPermission('orders')): master/owner/manager on,
  // head_coach/staff off.
  const loc = { features: {}, permissions: { mobile: {} } }

  it('defaults ON for master / owner / manager', () => {
    expect(canMobile({ role: 'master' }, 'orders', loc)).toBe(true)
    expect(canMobile({ role: 'owner' }, 'orders', loc)).toBe(true)
    expect(canMobile({ role: 'manager' }, 'orders', loc)).toBe(true)
  })

  it('defaults OFF for head_coach / staff', () => {
    expect(canMobile({ role: 'head_coach' }, 'orders', loc)).toBe(false)
    expect(canMobile({ role: 'staff' }, 'orders', loc)).toBe(false)
  })
})

describe('canMobile — car_processing default (W2 parity inversion)', () => {
  // CCF Autos tracker — master only by default; per-user opt-in for
  // everyone else, matching the web car_processing key.
  const loc = { features: {}, permissions: { mobile: {} } }

  it('defaults ON for master only', () => {
    expect(canMobile({ role: 'master' }, 'car_processing', loc)).toBe(true)
  })

  it('defaults OFF for owner / manager / head_coach / staff', () => {
    expect(canMobile({ role: 'owner' }, 'car_processing', loc)).toBe(false)
    expect(canMobile({ role: 'manager' }, 'car_processing', loc)).toBe(false)
    expect(canMobile({ role: 'head_coach' }, 'car_processing', loc)).toBe(false)
    expect(canMobile({ role: 'staff' }, 'car_processing', loc)).toBe(false)
  })

  it('is grantable per-user — an owner with an explicit override sees it', () => {
    const granted = { features: {}, permissions: { mobile: { car_processing: true } } }
    expect(canMobile({ role: 'owner' }, 'car_processing', granted)).toBe(true)
  })
})

describe('canMobile — races default (W3 parity inversion)', () => {
  // Race-day control's entry point is the manager-gated GET /api/races, so
  // the mobile feature defaults to manager+ (master/owner/manager/head_coach),
  // NOT staff — even though the web `races` permission is on for staff (they
  // do race-day on the shared control screen, not their own device).
  const loc = { features: {}, permissions: { mobile: {} } }

  it('defaults ON for master / owner / manager / head_coach', () => {
    expect(canMobile({ role: 'master' }, 'races', loc)).toBe(true)
    expect(canMobile({ role: 'owner' }, 'races', loc)).toBe(true)
    expect(canMobile({ role: 'manager' }, 'races', loc)).toBe(true)
    expect(canMobile({ role: 'head_coach' }, 'races', loc)).toBe(true)
  })

  it('defaults OFF for staff', () => {
    expect(canMobile({ role: 'staff' }, 'races', loc)).toBe(false)
  })

  it('honours the location feature gate (races off at this studio)', () => {
    expect(canMobile({ role: 'manager' }, 'races', { features: { races: false }, permissions: { mobile: {} } })).toBe(false)
  })
})
