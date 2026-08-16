// Smoke + invariants for shared/permissions.js — the single source
// of truth that both the web admin (StaffForm.jsx) and the iOS app
// (mobile/lib/permissions.js) import.
//
// Catches the most common mistakes when adding a new feature:
//   - default-by-role map missing the new key
//   - mobile entry referencing a webEquivalent that doesn't exist
//   - notification-flag default that's "on" while push_notifications
//     is "off" (silently dead config)
//
// The npm-script-level linter (scripts/check-mobile-parity.mjs)
// covers the inter-file drift; this file covers the within-file
// invariants.

import { describe, it, expect } from 'vitest'
import {
  MOBILE_PERMISSIONS,
  WEB_PERMISSIONS,
  WEB_PERMISSION_KEYS, MOBILE_PERMISSION_KEYS,
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
  isFeatureEnabledAtLocation,
  isFeatureGatedByLocation,
  NOTIFY_KEYS,
  APPROVAL_SUBPERMISSION_KEYS,
  LANDING_PREFERENCE_VALUES,
  LANDING_PREFERENCE_TARGETS,
  resolveLandingPreference,
} from '@shared/permissions'
import { hasPermission, hasMobilePermission } from './permissions.js'
import { CORE_KEYS } from '@shared/permission-bundles'

// Derived from the defaults map, NEVER hardcoded. A hardcoded list
// (['owner','manager','head_coach','staff']) silently left `master` and
// `reception` outside every invariant below: a new permission key
// omitted from those two blocks passed CI, then resolved at whatever
// resolvePermission's default tier decided — and since unregistered
// keys fail CLOSED for every role except master, the practical effect
// was a role quietly losing access to a new feature with no signal.
// Deriving means a seventh role is covered the moment it's added.
const ROLES = Object.keys(DEFAULT_WEB_PERMISSIONS_BY_ROLE)

// locationGateOnly keys (e.g. approvals_inbox — APPROVALS-PERCAT.1) are
// derived-visibility aggregator cards, not directly-granted role perms,
// so they're deliberately absent from every role default map.
const DIRECT_WEB_KEYS = WEB_PERMISSIONS.filter(p => !p.locationGateOnly).map(p => p.key)

describe('shared/permissions.js', () => {
  it('every role has a default-by-role map for both web and mobile', () => {
    for (const r of ROLES) {
      expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE[r], `web defaults for ${r}`).toBeDefined()
      expect(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[r], `mobile defaults for ${r}`).toBeDefined()
    }
  })

  it('web and mobile declare the SAME role set', () => {
    // ROLES derives from the web map, so a role present only in the
    // mobile map would escape every loop below. Pin both directions.
    expect(Object.keys(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE).sort()).toEqual([...ROLES].sort())
  })

  it('ROLES is derived, and covers the roles a hardcoded list used to miss', () => {
    // Regression guard for the drift this file used to have. If a role
    // is renamed/removed this fails loudly rather than silently
    // shrinking the coverage of every other test in the block.
    expect(ROLES).toEqual(expect.arrayContaining(['master', 'reception']))
  })

  it('every directly-granted web permission key appears in every role default map', () => {
    for (const r of ROLES) {
      for (const k of DIRECT_WEB_KEYS) {
        expect(
          DEFAULT_WEB_PERMISSIONS_BY_ROLE[r][k],
          `${r}/${k} should be a boolean`
        ).toBeTypeOf('boolean')
      }
    }
  })

  it('every mobile permission key appears in every role default map', () => {
    for (const r of ROLES) {
      for (const k of MOBILE_PERMISSION_KEYS) {
        expect(
          DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[r][k],
          `${r}/${k} should be a boolean`
        ).toBeTypeOf('boolean')
      }
    }
  })

  it('mobile entries with webEquivalent must reference a known web key', () => {
    const webSet = new Set(WEB_PERMISSION_KEYS)
    for (const m of MOBILE_PERMISSIONS) {
      if (m.mobileOnly) continue
      expect(
        m.webEquivalent,
        `${m.key} must declare either webEquivalent or mobileOnly:true`
      ).toBeDefined()
      expect(
        webSet.has(m.webEquivalent),
        `${m.key}.webEquivalent='${m.webEquivalent}' is not a known web permission`
      ).toBe(true)
    }
  })

  it('notification flags are only meaningful when push_notifications is on', () => {
    // Pure consistency check: if a role has push_notifications=false but
    // notify_<x>=true, the notify_<x> setting is dead config. Surface it.
    for (const r of ROLES) {
      const m = DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[r]
      if (m.push_notifications) continue
      const liveNotifies = MOBILE_PERMISSIONS
        .filter(p => p.isNotify && m[p.key])
        .map(p => p.key)
      expect(
        liveNotifies,
        `${r} has push_notifications=false but live notify keys: ${liveNotifies.join(', ')}`
      ).toEqual([])
    }
  })

  it('manager role mobile defaults are a superset of staff', () => {
    // Sanity: promoting someone from staff to manager should never
    // *take away* any mobile capability. (Inverse of the
    // staff-defaults-off-by-default convention.)
    const s = DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.staff
    const m = DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.manager
    for (const k of MOBILE_PERMISSION_KEYS) {
      if (s[k] && !m[k]) {
        throw new Error(`Manager loses '${k}' relative to staff. Defaults are inconsistent.`)
      }
    }
  })
})

describe('per-location feature gate (isFeatureEnabledAtLocation)', () => {
  it('returns true when the location has no features map at all', () => {
    expect(isFeatureEnabledAtLocation(null, 'pipeline')).toBe(true)
    expect(isFeatureEnabledAtLocation({}, 'pipeline')).toBe(true)
    expect(isFeatureEnabledAtLocation({ features: {} }, 'pipeline')).toBe(true)
  })

  it('returns true when the key is missing from features (default-on semantics)', () => {
    expect(isFeatureEnabledAtLocation({ features: { schedule: false } }, 'pipeline')).toBe(true)
  })

  it('returns true when explicitly true', () => {
    expect(isFeatureEnabledAtLocation({ features: { pipeline: true } }, 'pipeline')).toBe(true)
  })

  it('returns false when explicitly false', () => {
    expect(isFeatureEnabledAtLocation({ features: { pipeline: false } }, 'pipeline')).toBe(false)
  })

  it('notification keys are NEVER location-gated regardless of features value', () => {
    for (const k of NOTIFY_KEYS) {
      expect(isFeatureGatedByLocation(k)).toBe(false)
      // Even an explicit false in the location map is ignored for notify_*
      expect(isFeatureEnabledAtLocation({ features: { [k]: false } }, k)).toBe(true)
    }
  })
})

// BUNDLES.5 Task 1 — isFeatureEnabledAtLocation now ORs in
// bundlesDenyKey(features, key) on top of the existing individual-key
// check: `features[key] !== false && !bundlesDenyKey(features, key)`.
describe('per-location feature gate — bundle layer (BUNDLES.5)', () => {
  it('denies a bundled key when its owning bundle is explicitly false, even with no individual-key false', () => {
    expect(isFeatureEnabledAtLocation({ features: { bundle_sales: false } }, 'pipeline')).toBe(false)
  })

  it('does not deny a bundled key when its owning bundle is true or unset', () => {
    expect(isFeatureEnabledAtLocation({ features: { bundle_sales: true } }, 'pipeline')).toBe(true)
    expect(isFeatureEnabledAtLocation({ features: {} }, 'pipeline')).toBe(true)
  })

  it('OR semantics: a key owned by two bundles survives if only one is off', () => {
    // `email` is owned by both bundle_messaging and bundle_marketing.
    expect(isFeatureEnabledAtLocation({ features: { bundle_messaging: false, bundle_marketing: true } }, 'email')).toBe(true)
    expect(isFeatureEnabledAtLocation({ features: { bundle_messaging: false, bundle_marketing: false } }, 'email')).toBe(false)
  })

  it('an individual-key false still denies even when every owning bundle is true (existing exception mechanism, unaffected)', () => {
    expect(isFeatureEnabledAtLocation({ features: { pipeline: false, bundle_sales: true } }, 'pipeline')).toBe(false)
  })

  it('CORE keys (settings, dashboards, issues_inbox, approvals_inbox, …) are never denied by any bundle', () => {
    for (const key of CORE_KEYS) {
      expect(isFeatureEnabledAtLocation({
        features: { bundle_sales: false, bundle_members: false, bundle_money: false, bundle_messaging: false, bundle_marketing: false, bundle_team: false, bundle_operations: false, module_cars: false },
      }, key)).toBe(true)
    }
  })

  // BUNDLES.5 final-review fix 1 (the "Money chrome leak"): approvals_*
  // keys are exempt from THEIR OWN per-key toggle, but now follow their
  // owning CATEGORY's bundle (shared/permissions.js
  // APPROVAL_CATEGORY_PERMISSION → shared/permission-bundles.js
  // CATEGORY_BUNDLES), via the same mechanism Task 2 wired into the
  // approvals registry. Replaces the old "stay exempt from the bundle
  // layer too" test, which was the bug: it asserted the leak as
  // correct behaviour.
  describe('approvals_* keys: per-key exempt, category-bundle-followed', () => {
    it('an individual approvals_* key toggle (features["approvals_x"] = false) does NOTHING — still per-key exempt', () => {
      for (const key of APPROVAL_SUBPERMISSION_KEYS) {
        expect(isFeatureEnabledAtLocation({ features: { [key]: false } }, key), key).toBe(true)
      }
    })

    it('every bundle owning the key\'s category off DOES deny it now', () => {
      // contractor_invoices / fte_expenses / offer_purchases → bundle_money
      expect(isFeatureEnabledAtLocation({ features: { bundle_money: false } }, 'approvals_contractor_invoices')).toBe(false)
      expect(isFeatureEnabledAtLocation({ features: { bundle_money: false } }, 'approvals_fte_expenses')).toBe(false)
      expect(isFeatureEnabledAtLocation({ features: { bundle_money: false } }, 'approvals_offer_purchases')).toBe(false)
      // time_off / shift_swaps / rosters → bundle_team
      expect(isFeatureEnabledAtLocation({ features: { bundle_team: false } }, 'approvals_time_off')).toBe(false)
      expect(isFeatureEnabledAtLocation({ features: { bundle_team: false } }, 'approvals_shift_swaps')).toBe(false)
      expect(isFeatureEnabledAtLocation({ features: { bundle_team: false } }, 'approvals_rosters')).toBe(false)
      // hyrox_sessions → bundle_members
      expect(isFeatureEnabledAtLocation({ features: { bundle_members: false } }, 'approvals_hyrox_sessions')).toBe(false)
      // agent_requests → bundle_sales OR bundle_members (OR semantics)
      expect(isFeatureEnabledAtLocation({ features: { bundle_sales: false, bundle_members: true } }, 'approvals_agent_requests')).toBe(true)
      expect(isFeatureEnabledAtLocation({ features: { bundle_sales: false, bundle_members: false } }, 'approvals_agent_requests')).toBe(false)
    })

    it('the individual-key exemption and the category-bundle check are independent — {} (bundle on) always enables regardless of the (never-consulted) individual key', () => {
      for (const key of APPROVAL_SUBPERMISSION_KEYS) {
        expect(isFeatureEnabledAtLocation({ features: {} }, key), key).toBe(true)
      }
    })

    it('every bundle off (every category loses its owner) denies all 8 approvals_* keys', () => {
      const features = { bundle_sales: false, bundle_members: false, bundle_money: false, bundle_messaging: false, bundle_marketing: false, bundle_team: false, bundle_operations: false, module_cars: false }
      for (const key of APPROVAL_SUBPERMISSION_KEYS) {
        expect(isFeatureEnabledAtLocation({ features }, key), key).toBe(false)
      }
    })
  })

  it('{} (every existing location today) still means everything on — back-compat is sacred', () => {
    expect(isFeatureEnabledAtLocation({ features: {} }, 'pipeline')).toBe(true)
    expect(isFeatureEnabledAtLocation({ features: {} }, 'car_processing')).toBe(true)
    expect(isFeatureEnabledAtLocation({ features: {} }, 'settings')).toBe(true)
  })
})

describe('notification registry ↔ per-user toggles', () => {
  it('every sendPush category in the registry has a notify_<category> toggle', async () => {
    // push.js only skips a user when notify_<category> is explicitly
    // false — a category with NO toggle in MOBILE_PERMISSIONS sends to
    // everyone with no way to opt out (the expense_* gap). Guard the
    // registry → toggle direction. (The inverse isn't asserted: some
    // notify_* keys — instagram, checklist_*, issue_* — predate their
    // registry entries.)
    const { NOTIFICATION_REGISTRY } = await import('./notifications-registry.js')
    const keys = new Set(MOBILE_PERMISSION_KEYS)
    for (const entry of NOTIFICATION_REGISTRY) {
      expect(
        keys.has(`notify_${entry.category}`),
        `registry category '${entry.category}' has no notify_${entry.category} toggle in MOBILE_PERMISSIONS`
      ).toBe(true)
    }
  })

  it('expense notify defaults: submitted = approver roles only, outcomes = everyone', () => {
    // expense_submitted fans out to the approval queue → on for
    // master/owner/manager/head_coach, off for staff. approved +
    // declined go to the submitting FTE → on for every role.
    const d = DEFAULT_MOBILE_PERMISSIONS_BY_ROLE
    expect(d.master.notify_expense_submitted).toBe(true)
    expect(d.owner.notify_expense_submitted).toBe(true)
    expect(d.manager.notify_expense_submitted).toBe(true)
    expect(d.head_coach.notify_expense_submitted).toBe(true)
    expect(d.staff.notify_expense_submitted).toBe(false)
    expect(d.reception.notify_expense_submitted).toBe(false)  // front desk doesn't approve
    for (const r of ROLES) {
      expect(d[r].notify_expense_approved, `${r}.notify_expense_approved`).toBe(true)
      expect(d[r].notify_expense_declined, `${r}.notify_expense_declined`).toBe(true)
    }
  })
})

describe('mig 093 — studio_management replaces door_unlock', () => {
  it('studio_management is a top-level web key (cross-platform)', () => {
    expect(WEB_PERMISSION_KEYS).toContain('studio_management')
  })

  it('door_unlock is gone from the mobile registry', () => {
    expect(MOBILE_PERMISSION_KEYS).not.toContain('door_unlock')
  })

  it('studio_management is NOT under the mobile namespace', () => {
    // The whole point of the rename was to make it cross-platform —
    // top-level on permissions, like dashboard_*. Listing it under
    // mobile would mean two separate toggles for the same feature.
    expect(MOBILE_PERMISSION_KEYS).not.toContain('studio_management')
  })

  it('role defaults: master/owner/manager on, head_coach/staff off', () => {
    expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE.master.studio_management).toBe(true)
    expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE.owner.studio_management).toBe(true)
    expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE.manager.studio_management).toBe(true)
    expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE.head_coach.studio_management).toBe(false)
    expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE.staff.studio_management).toBe(false)
  })

  it('mobile role defaults no longer carry door_unlock', () => {
    for (const r of ROLES) {
      expect(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[r]).not.toHaveProperty('door_unlock')
    }
  })
})

describe('mig 092 audit — orders + races permission keys', () => {
  // The audit added dedicated `orders` and `races` keys (previously
  // these routes piggybacked on `events|car_processing` / `events`).
  // Lock the role defaults + location-gate honour so a regression
  // doesn't silently re-attach them to the wrong parent permission.

  it('orders is a valid permission key with role defaults', () => {
    expect(WEB_PERMISSION_KEYS).toContain('orders')
    expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE.owner.orders).toBe(true)
    expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE.manager.orders).toBe(true)
    // Front-of-house roles default to off — financial views are an
    // explicit opt-in even if the location has Orders enabled.
    expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE.head_coach.orders).toBe(false)
    expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE.staff.orders).toBe(false)
  })

  it('races is a valid permission key with role defaults', () => {
    expect(WEB_PERMISSION_KEYS).toContain('races')
    // Race-day starts/finishes are a front-of-house duty, so every
    // role defaults to true — same shape as `events`.
    for (const r of ROLES) {
      expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE[r].races, `${r}/events`).toBe(true)
    }
  })

  it('a location can disable Races without disabling booking Events', () => {
    const u = (role) => ({
      role,
      activeLocation: { features: { races: false /* events stays on */ } },
      permissions: {},
    })
    expect(hasPermission(u('owner'), 'events')).toBe(true)
    expect(hasPermission(u('owner'), 'races')).toBe(false)
  })

  it('a location can disable Orders independently of Events + Cars', () => {
    const u = (role) => ({
      role,
      activeLocation: { features: { orders: false } },
      permissions: {},
    })
    expect(hasPermission(u('manager'), 'events')).toBe(true)
    expect(hasPermission(u('manager'), 'car_processing')).toBe(false) // role default
    expect(hasPermission(u('manager'), 'orders')).toBe(false)
  })
})

describe('master role gating (mig 033 + location-gate honour)', () => {
  it('master honours the per-location feature gate just like everyone else', () => {
    // CCF Autos scenario: location has every feature off except
    // car_processing. A master at that location should NOT see the
    // off features in the sidebar — otherwise "disabled at location"
    // is meaningless.
    const master = {
      role: 'master',
      activeLocation: {
        features: { pipeline: false, schedule: false, car_processing: true },
      },
      permissions: {},
    }
    expect(hasPermission(master, 'pipeline')).toBe(false)
    expect(hasPermission(master, 'schedule')).toBe(false)
    expect(hasPermission(master, 'car_processing')).toBe(true)
  })

  it("master's 'settings' key is the escape hatch — visible even when location turns settings off", () => {
    // Without this, a master at a location with settings disabled
    // would have no way back into the per-location feature toggles
    // from the sidebar. Settings is the ONLY key with this exemption.
    const master = {
      role: 'master',
      activeLocation: { features: { settings: false, pipeline: false } },
      permissions: {},
    }
    expect(hasPermission(master, 'settings')).toBe(true)
    expect(hasPermission(master, 'pipeline')).toBe(false) // still gated
  })

  it('master bypasses tier 2 + 3 once the location gate passes', () => {
    // No user override, no role-default lookup needed — once the
    // location says yes, master sees the feature.
    const master = {
      role: 'master',
      activeLocation: { features: {} }, // default-on
      permissions: {}, // empty — would deny a non-master without role default
    }
    expect(hasPermission(master, 'pipeline')).toBe(true)
    expect(hasPermission(master, 'car_processing')).toBe(true)
    expect(hasPermission(master, 'unknown_future_feature_key')).toBe(true)
  })
})

describe('hasPermission three-tier resolution (mig 058: per-location override)', () => {
  // Helpers to build user-shaped fixtures. Resolution now reads from
  // user.activeAssignment.permissions (per-location), not from
  // user.permissions (profile-wide). The fixture defaults to manager
  // role at a permissive location with empty per-location permissions
  // (i.e. role default applies).
  const baseLoc = { id: 'loc1', features: {} }
  const u = (overrides = {}) => ({
    role: 'manager',
    activeLocation: baseLoc,
    activeAssignment: { permissions: {} },
    ...overrides,
  })

  it('returns false for null user', () => {
    expect(hasPermission(null, 'pipeline')).toBe(false)
  })

  it('tier 1: location features[key]=false denies regardless of override', () => {
    const user = u({
      activeLocation: { features: { pipeline: false } },
      activeAssignment: { permissions: { pipeline: true } }, // user said yes; location wins
    })
    expect(hasPermission(user, 'pipeline')).toBe(false)
  })

  it('tier 2: per-location override === true grants when location is permissive', () => {
    expect(hasPermission(
      u({ activeAssignment: { permissions: { car_processing: true } } }),
      'car_processing',
    )).toBe(true)
  })

  it('tier 2: per-location override === false denies even if role default is true', () => {
    expect(hasPermission(
      u({ role: 'manager', activeAssignment: { permissions: { schedule: false } } }),
      'schedule',
    )).toBe(false)
  })

  it('tier 3: falls back to role default when no per-location override', () => {
    expect(hasPermission(u({ role: 'staff' }), 'schedule')).toBe(true)         // staff default
    expect(hasPermission(u({ role: 'staff' }), 'car_processing')).toBe(false)  // staff default false
    expect(hasPermission(u({ role: 'owner' }), 'settings')).toBe(true)         // owner default
  })

  it('per-location override does NOT leak across locations', () => {
    // Garrett-like fixture: same user, different active locations, same
    // active-assignment-shaped data. The per-location override at A
    // shouldn't grant the feature at B (B's assignment has empty {}).
    const atOwnerLoc = u({
      role: 'owner',
      activeLocation: { id: 'A', features: {} },
      activeAssignment: { permissions: { dashboard_business: true } },
    })
    const atStaffLoc = u({
      role: 'staff',
      activeLocation: { id: 'B', features: {} },
      activeAssignment: { permissions: {} }, // empty -> role default
    })
    expect(hasPermission(atOwnerLoc, 'dashboard_business')).toBe(true)         // owner override at A
    expect(hasPermission(atStaffLoc, 'dashboard_business')).toBe(false)        // staff role default at B
  })

  it('profile-wide user.permissions is NO LONGER read (mig 058)', () => {
    // If something stale on the user object still has the old
    // profile-wide permissions blob, hasPermission must ignore it.
    const user = u({
      role: 'staff',
      // Old shape lives on as a back-compat field — explicitly NOT
      // a basis for granting permission anymore.
      permissions: { dashboard_business: true, settings: true },
      activeAssignment: { permissions: {} },
    })
    expect(hasPermission(user, 'dashboard_business')).toBe(false) // staff default
    expect(hasPermission(user, 'settings')).toBe(false)           // staff default
  })

  it('missing activeAssignment falls through to role default (no crash)', () => {
    const user = u({ role: 'staff', activeAssignment: null })
    expect(() => hasPermission(user, 'schedule')).not.toThrow()
    expect(hasPermission(user, 'schedule')).toBe(true)            // staff default
  })

  it('notification keys ignore the location gate (still go to user/role)', () => {
    const user = u({
      activeLocation: { features: { notify_swap: false } }, // ignored
      activeAssignment: { permissions: { mobile: { notify_swap: true } } },
    })
    // hasPermission is web-only (web sidebar), notify_* are mobile-only —
    // covered by the mobile canMobile() check. But verify that even if
    // a notify_* key showed up in the web check, the location wouldn't
    // gate it.
    expect(() => hasPermission(user, 'notify_swap')).not.toThrow()
  })
})

describe('MOBILE-RADAR — radar mobile permissions', () => {
  it('churn_radar + lead_radar are registered mobile permission keys', () => {
    expect(MOBILE_PERMISSION_KEYS).toContain('churn_radar')
    expect(MOBILE_PERMISSION_KEYS).toContain('lead_radar')
  })

  it('mobile radar entries map to the matching web permission', () => {
    for (const key of ['churn_radar', 'lead_radar']) {
      const entry = MOBILE_PERMISSIONS.find(m => m.key === key)
      expect(entry, `${key} mobile entry`).toBeDefined()
      expect(entry.webEquivalent).toBe(key)
    }
  })

  it('role defaults: owner/head_coach on, manager/staff off', () => {
    for (const key of ['churn_radar', 'lead_radar']) {
      expect(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.owner[key]).toBe(true)
      expect(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.head_coach[key]).toBe(true)
      expect(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.manager[key]).toBe(false)
      expect(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE.staff[key]).toBe(false)
    }
  })
})

describe('hasMobilePermission — server-side .mobile gate', () => {
  const u = (overrides = {}) => ({
    role: 'head_coach',
    activeLocation: { id: 'loc1', features: {} },
    activeAssignment: { permissions: { mobile: {} } },
    ...overrides,
  })

  it('returns false for a null user', () => {
    expect(hasMobilePermission(null, 'churn_radar')).toBe(false)
  })

  it('falls back to the mobile role default when there is no override', () => {
    expect(hasMobilePermission(u({ role: 'head_coach' }), 'churn_radar')).toBe(true)
    expect(hasMobilePermission(u({ role: 'staff' }), 'churn_radar')).toBe(false)
    expect(hasMobilePermission(u({ role: 'owner' }), 'lead_radar')).toBe(true)
    expect(hasMobilePermission(u({ role: 'manager' }), 'lead_radar')).toBe(false)
  })

  it('reads the per-user override from the .mobile namespace', () => {
    // Explicit true grants even for a role whose default is false.
    expect(hasMobilePermission(
      u({ role: 'staff', activeAssignment: { permissions: { mobile: { churn_radar: true } } } }),
      'churn_radar',
    )).toBe(true)
    // Explicit false denies even for a role whose default is true.
    expect(hasMobilePermission(
      u({ role: 'owner', activeAssignment: { permissions: { mobile: { lead_radar: false } } } }),
      'lead_radar',
    )).toBe(false)
  })

  it('ignores a top-level (non-.mobile) override — mobile keys are namespaced', () => {
    // A churn_radar key at the top level of the bag is the WEB
    // permission; it must not leak into the mobile resolution.
    expect(hasMobilePermission(
      u({ role: 'staff', activeAssignment: { permissions: { churn_radar: true } } }),
      'churn_radar',
    )).toBe(false)
  })

  it('honours the location feature gate (tier 1)', () => {
    expect(hasMobilePermission(
      u({ role: 'owner', activeLocation: { id: 'loc1', features: { churn_radar: false } } }),
      'churn_radar',
    )).toBe(false)
  })

  it('master bypasses the per-user tiers once the location gate passes', () => {
    expect(hasMobilePermission(
      u({ role: 'master', activeAssignment: { permissions: { mobile: {} } } }),
      'churn_radar',
    )).toBe(true)
  })
})

describe('landing preference resolver', () => {
  it('LANDING_PREFERENCE_VALUES contains the four expected values', () => {
    expect(LANDING_PREFERENCE_VALUES).toEqual(['auto', 'personal', 'studio', 'business'])
  })

  it('LANDING_PREFERENCE_TARGETS maps each non-auto value to a route + permission', () => {
    for (const v of LANDING_PREFERENCE_VALUES) {
      if (v === 'auto') continue
      const t = LANDING_PREFERENCE_TARGETS[v]
      expect(t, `target for ${v}`).toBeDefined()
      expect(t.route).toMatch(/^\/dashboard\//)
      expect(t.perm).toMatch(/^dashboard_/)
    }
  })

  it('resolveLandingPreference returns "auto" when permissions are missing', () => {
    expect(resolveLandingPreference(null)).toBe('auto')
    expect(resolveLandingPreference(undefined)).toBe('auto')
    expect(resolveLandingPreference({})).toBe('auto')
    expect(resolveLandingPreference({ permissions: {} })).toBe('auto')
  })

  it('resolveLandingPreference passes through known values', () => {
    expect(resolveLandingPreference({ permissions: { landing_preference: 'personal' } })).toBe('personal')
    expect(resolveLandingPreference({ permissions: { landing_preference: 'studio' } })).toBe('studio')
    expect(resolveLandingPreference({ permissions: { landing_preference: 'business' } })).toBe('business')
    expect(resolveLandingPreference({ permissions: { landing_preference: 'auto' } })).toBe('auto')
  })

  it('resolveLandingPreference defends against unknown / non-string values', () => {
    expect(resolveLandingPreference({ permissions: { landing_preference: 'bogus' } })).toBe('auto')
    expect(resolveLandingPreference({ permissions: { landing_preference: 42 } })).toBe('auto')
    expect(resolveLandingPreference({ permissions: { landing_preference: null } })).toBe('auto')
  })
})
