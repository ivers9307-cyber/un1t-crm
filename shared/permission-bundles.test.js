// BUNDLES.5 Task 1 — the bundle layer's own contract tests.
//
// Completeness is checked against the LIVE WEB_PERMISSIONS /
// MOBILE_PERMISSIONS exports (never hard-coded counts) so a future
// key addition that forgets to classify it here fails loudly instead
// of silently falling through bundlesDenyKey's "not owned by any
// bundle → never denied" default.

import { describe, it, expect } from 'vitest'
import {
  BUNDLE_KEYS,
  KEY_BUNDLES,
  CORE_KEYS,
  EXEMPT_KEYS,
  bundlesDenyKey,
  CATEGORY_BUNDLES,
  bundlesDenyCategory,
} from './permission-bundles.js'
import {
  WEB_PERMISSION_KEYS,
  MOBILE_PERMISSION_KEYS,
  NOTIFY_KEYS,
  APPROVAL_SUBPERMISSION_KEYS,
  APPROVAL_CATEGORY_PERMISSION,
  isFeatureEnabledAtLocation,
} from './permissions.js'

const ALL_KEYS = Array.from(new Set([...WEB_PERMISSION_KEYS, ...MOBILE_PERMISSION_KEYS]))

describe('BUNDLE_KEYS', () => {
  it('has exactly 7 hub bundles + module_cars (8 total)', () => {
    expect(BUNDLE_KEYS.length).toBe(8)
    expect(BUNDLE_KEYS).toContain('module_cars')
    const hubBundles = BUNDLE_KEYS.filter(k => k !== 'module_cars')
    expect(hubBundles.length).toBe(7)
    hubBundles.forEach(k => expect(k.startsWith('bundle_')).toBe(true))
  })

  it('has no duplicate entries', () => {
    expect(new Set(BUNDLE_KEYS).size).toBe(BUNDLE_KEYS.length)
  })

  it('collides with no WEB or MOBILE permission key', () => {
    BUNDLE_KEYS.forEach(b => {
      expect(WEB_PERMISSION_KEYS.includes(b)).toBe(false)
      expect(MOBILE_PERMISSION_KEYS.includes(b)).toBe(false)
    })
  })
})

describe('completeness — every WEB + MOBILE key is classified exactly once', () => {
  it('every key appears in exactly one of KEY_BUNDLES / CORE_KEYS / EXEMPT_KEYS', () => {
    const missing = []
    const duplicated = []
    for (const key of ALL_KEYS) {
      const inBundles = Object.prototype.hasOwnProperty.call(KEY_BUNDLES, key)
      const inCore = CORE_KEYS.includes(key)
      const inExempt = EXEMPT_KEYS.includes(key)
      const count = [inBundles, inCore, inExempt].filter(Boolean).length
      if (count === 0) missing.push(key)
      if (count > 1) duplicated.push(key)
    }
    expect(missing).toEqual([])
    expect(duplicated).toEqual([])
  })

  it('KEY_BUNDLES contains no keys outside the WEB/MOBILE key set', () => {
    const stray = Object.keys(KEY_BUNDLES).filter(k => !ALL_KEYS.includes(k))
    expect(stray).toEqual([])
  })

  it('CORE_KEYS contains no keys outside the WEB/MOBILE key set', () => {
    const stray = CORE_KEYS.filter(k => !ALL_KEYS.includes(k))
    expect(stray).toEqual([])
  })

  it('EXEMPT_KEYS contains no keys outside the WEB/MOBILE key set', () => {
    const stray = EXEMPT_KEYS.filter(k => !ALL_KEYS.includes(k))
    expect(stray).toEqual([])
  })

  it('every KEY_BUNDLES value is a non-empty array of valid BUNDLE_KEYS', () => {
    for (const [key, bundles] of Object.entries(KEY_BUNDLES)) {
      expect(Array.isArray(bundles), `${key} must map to an array`).toBe(true)
      expect(bundles.length, `${key} must own at least one bundle`).toBeGreaterThan(0)
      bundles.forEach(b => {
        expect(BUNDLE_KEYS.includes(b), `${key} owns unknown bundle '${b}'`).toBe(true)
      })
    }
  })
})

// BUNDLES.5 final-review fix 1 — restructured: EXEMPT_KEYS is still one
// literal list (the drift guard below is unchanged), but the TWO
// halves that make it up are no longer symmetric in how the bundle
// layer treats them, so the guard now says so explicitly rather than
// implying "exempt" means the same thing for both.
describe('EXEMPT_KEYS mirrors the existing location-gate exemptions', () => {
  it('exactly matches NOTIFY_KEYS ∪ APPROVAL_SUBPERMISSION_KEYS (drift guard)', () => {
    const expected = new Set([...NOTIFY_KEYS, ...APPROVAL_SUBPERMISSION_KEYS])
    expect(new Set(EXEMPT_KEYS)).toEqual(expected)
  })

  it('bundlesDenyKey (the KEY_BUNDLES-based per-key check) never denies EITHER half — that part IS still symmetric', () => {
    const everyBundleOff = Object.fromEntries(BUNDLE_KEYS.map(b => [b, false]))
    for (const key of EXEMPT_KEYS) {
      expect(bundlesDenyKey(everyBundleOff, key), key).toBe(false)
      expect(KEY_BUNDLES[key], key).toBeUndefined()
    }
  })

  it('notify_* keys: FULLY exempt — isFeatureEnabledAtLocation never denies them, no matter how every bundle is set', () => {
    const everyBundleOff = { bundle_sales: false, bundle_members: false, bundle_money: false, bundle_messaging: false, bundle_marketing: false, bundle_team: false, bundle_operations: false, module_cars: false }
    for (const key of NOTIFY_KEYS) {
      expect(isFeatureEnabledAtLocation({ features: everyBundleOff }, key), key).toBe(true)
    }
  })

  it('approvals_* keys: per-key exempt (their own features[key]=false is ignored) but CATEGORY-bundle-followed — every APPROVAL_SUBPERMISSION_KEYS entry maps to a real CATEGORY_BUNDLES category', () => {
    for (const key of APPROVAL_SUBPERMISSION_KEYS) {
      // Per-key exempt: an individual override does nothing on its own.
      expect(isFeatureEnabledAtLocation({ features: { [key]: false } }, key), key).toBe(true)
      // Category-bundle-followed: every approvals_* key's category (the
      // reverse of shared/permissions.js APPROVAL_CATEGORY_PERMISSION)
      // is a real, non-empty CATEGORY_BUNDLES entry — so
      // isFeatureEnabledAtLocation has a real bundle check to run, not
      // a silent no-op.
      const category = Object.entries(APPROVAL_CATEGORY_PERMISSION).find(([, k]) => k === key)?.[0]
      expect(category, key).toBeTruthy()
      expect(CATEGORY_BUNDLES[category], category).toBeDefined()
      expect(CATEGORY_BUNDLES[category].length, category).toBeGreaterThan(0)
    }
  })
})

describe('bundlesDenyKey — polarity (back-compat is sacred)', () => {
  it('an empty features object ({}) denies nothing, for any bundled key', () => {
    Object.keys(KEY_BUNDLES).forEach(key => {
      expect(bundlesDenyKey({}, key)).toBe(false)
    })
  })

  it('a null/undefined features object denies nothing', () => {
    expect(bundlesDenyKey(null, 'pipeline')).toBe(false)
    expect(bundlesDenyKey(undefined, 'pipeline')).toBe(false)
  })

  it('a key owned by zero bundles (core/exempt) is never denied, even if every bundle is off', () => {
    const everyBundleOff = Object.fromEntries(BUNDLE_KEYS.map(b => [b, false]))
    CORE_KEYS.forEach(key => {
      expect(bundlesDenyKey(everyBundleOff, key)).toBe(false)
    })
    EXEMPT_KEYS.forEach(key => {
      expect(bundlesDenyKey(everyBundleOff, key)).toBe(false)
    })
  })
})

describe('bundlesDenyKey — single-bundle keys', () => {
  it('denies when its one owning bundle is explicitly false', () => {
    expect(bundlesDenyKey({ bundle_sales: false }, 'pipeline')).toBe(true)
  })

  it('does not deny when the bundle is true or missing', () => {
    expect(bundlesDenyKey({ bundle_sales: true }, 'pipeline')).toBe(false)
    expect(bundlesDenyKey({}, 'pipeline')).toBe(false)
  })

  it('car_processing maps 1:1 to module_cars only', () => {
    expect(KEY_BUNDLES.car_processing).toEqual(['module_cars'])
    expect(bundlesDenyKey({ module_cars: false }, 'car_processing')).toBe(true)
    // module_cars is opt-in (off by default in spirit), but an EXPLICIT
    // true still enables it — polarity is uniform across all bundles.
    expect(bundlesDenyKey({ module_cars: true }, 'car_processing')).toBe(false)
  })
})

describe('bundlesDenyKey — OR semantics across multiple owning bundles', () => {
  it('email is owned by both bundle_messaging and bundle_marketing', () => {
    expect(KEY_BUNDLES.email.sort()).toEqual(['bundle_marketing', 'bundle_messaging'])
  })

  it('denies only when EVERY owning bundle is explicitly false', () => {
    expect(bundlesDenyKey({ bundle_messaging: false, bundle_marketing: false }, 'email')).toBe(true)
  })

  it('does not deny when only one owning bundle is false', () => {
    expect(bundlesDenyKey({ bundle_messaging: false, bundle_marketing: true }, 'email')).toBe(false)
    expect(bundlesDenyKey({ bundle_messaging: true, bundle_marketing: false }, 'email')).toBe(false)
  })

  it('does not deny when neither owning bundle is set', () => {
    expect(bundlesDenyKey({}, 'email')).toBe(false)
  })

  it('studio_management is owned by both bundle_members and bundle_operations', () => {
    expect(KEY_BUNDLES.studio_management.sort()).toEqual(['bundle_members', 'bundle_operations'])
    expect(bundlesDenyKey({ bundle_members: false, bundle_operations: true }, 'studio_management')).toBe(false)
    expect(bundlesDenyKey({ bundle_members: false, bundle_operations: false }, 'studio_management')).toBe(true)
  })

  // SHELLY-UI.8 — device_control widened from bundle_marketing-only to
  // Marketing OR Operations (Richard, 2026-08-22: Sonos speakers and
  // Shelly smart plugs are studio hardware, an operations concern as
  // much as a marketing one). The Marketing-off/Operations-on row is
  // the whole point of the change and is asserted first.
  it('device_control is owned by both bundle_marketing and bundle_operations', () => {
    expect(KEY_BUNDLES.device_control.sort()).toEqual(['bundle_marketing', 'bundle_operations'])
    // Marketing OFF, Operations ON — an operations-only tenant keeps it.
    expect(bundlesDenyKey({ bundle_marketing: false, bundle_operations: true }, 'device_control')).toBe(false)
    // The mirror case, for symmetry: a marketing-only tenant keeps it too.
    expect(bundlesDenyKey({ bundle_marketing: true, bundle_operations: false }, 'device_control')).toBe(false)
    // Both OFF — and only then — the bundle layer denies it.
    expect(bundlesDenyKey({ bundle_marketing: false, bundle_operations: false }, 'device_control')).toBe(true)
    // Both ON, and the back-compat `{}`, deny nothing.
    expect(bundlesDenyKey({ bundle_marketing: true, bundle_operations: true }, 'device_control')).toBe(false)
    expect(bundlesDenyKey({}, 'device_control')).toBe(false)
  })
})

describe('spot-check assignments the reviewer will verify against the pages they gate', () => {
  it('the 8 approvals_* sub-permission keys are EXEMPT, not bundled (Task 2 handles categories)', () => {
    APPROVAL_SUBPERMISSION_KEYS.forEach(key => {
      expect(EXEMPT_KEYS.includes(key)).toBe(true)
      expect(KEY_BUNDLES[key]).toBeUndefined()
    })
  })

  it('settings, dashboards, issues_inbox and approvals_inbox are core (never bundled)', () => {
    ;['settings', 'dashboard_personal', 'dashboard_studio', 'dashboard_business', 'dashboard_ads', 'issues_inbox', 'approvals_inbox']
      .forEach(key => expect(CORE_KEYS.includes(key)).toBe(true))
  })

  it('contracts and attendance_reports land in bundle_team', () => {
    expect(KEY_BUNDLES.contracts).toEqual(['bundle_team'])
    expect(KEY_BUNDLES.attendance_reports).toEqual(['bundle_team'])
  })

  // R1 (final-review rider) — mobile `issues` ("Report a Problem") and
  // mobile `policies` (HR policy reading) were reclassified OUT of
  // KEY_BUNDLES (bundle_operations / bundle_team respectively) INTO
  // CORE_KEYS: both mirror web surfaces that are deliberately ungated
  // (POST /api/issues has no permission gate by design; /policies is
  // login-only), so a bundle hiding them would be an unintended side
  // effect rather than a real product decision.
  it('R1: issues and policies are CORE, not bundled — baseline/compliance surfaces', () => {
    expect(CORE_KEYS.includes('issues')).toBe(true)
    expect(CORE_KEYS.includes('policies')).toBe(true)
    expect(KEY_BUNDLES.issues).toBeUndefined()
    expect(KEY_BUNDLES.policies).toBeUndefined()
    const everyBundleOff = Object.fromEntries(BUNDLE_KEYS.map(b => [b, false]))
    expect(bundlesDenyKey(everyBundleOff, 'issues')).toBe(false)
    expect(bundlesDenyKey(everyBundleOff, 'policies')).toBe(false)
  })
})

// BUNDLES.5 Task 2 — category→bundle map for the approvals registry
// (src/lib/approvals/registry.js). See registry.test.js for the
// integration-level tests exercising getPendingApprovals /
// getPendingApprovalsCount end to end; these are the pure unit tests
// for the map + resolver primitive themselves.
describe('CATEGORY_BUNDLES + bundlesDenyCategory', () => {
  it('every CATEGORY_BUNDLES value is a non-empty array of valid BUNDLE_KEYS', () => {
    for (const [category, bundles] of Object.entries(CATEGORY_BUNDLES)) {
      expect(Array.isArray(bundles), `${category} must map to an array`).toBe(true)
      expect(bundles.length, `${category} must own at least one bundle`).toBeGreaterThan(0)
      bundles.forEach(b => {
        expect(BUNDLE_KEYS.includes(b), `${category} owns unknown bundle '${b}'`).toBe(true)
      })
    }
  })

  it('polarity: {} denies no category (back-compat)', () => {
    Object.keys(CATEGORY_BUNDLES).forEach(category => {
      expect(bundlesDenyCategory({}, category)).toBe(false)
    })
    expect(bundlesDenyCategory(null, 'contractor_invoices')).toBe(false)
  })

  it('a category owning zero bundles (e.g. the unmapped "issues" core category) is never denied', () => {
    const everyBundleOff = Object.fromEntries(BUNDLE_KEYS.map(b => [b, false]))
    expect(bundlesDenyCategory(everyBundleOff, 'issues')).toBe(false)
  })

  it('denies a single-bundle category when its bundle is explicitly false', () => {
    expect(bundlesDenyCategory({ bundle_money: false }, 'contractor_invoices')).toBe(true)
    expect(bundlesDenyCategory({ bundle_money: true }, 'contractor_invoices')).toBe(false)
  })

  it('agent_requests — OR semantics across bundle_sales + bundle_members', () => {
    expect(CATEGORY_BUNDLES.agent_requests.slice().sort()).toEqual(['bundle_members', 'bundle_sales'])
    expect(bundlesDenyCategory({ bundle_sales: false, bundle_members: true }, 'agent_requests')).toBe(false)
    expect(bundlesDenyCategory({ bundle_sales: true, bundle_members: false }, 'agent_requests')).toBe(false)
    expect(bundlesDenyCategory({ bundle_sales: false, bundle_members: false }, 'agent_requests')).toBe(true)
  })

  it('contractor_invoices / fte_expenses / offer_purchases follow bundle_money (approval = review, per the plan)', () => {
    expect(CATEGORY_BUNDLES.contractor_invoices).toEqual(['bundle_money'])
    expect(CATEGORY_BUNDLES.fte_expenses).toEqual(['bundle_money'])
    expect(CATEGORY_BUNDLES.offer_purchases).toEqual(['bundle_money'])
  })
})
