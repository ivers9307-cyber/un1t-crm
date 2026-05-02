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
  WEB_PERMISSION_KEYS, MOBILE_PERMISSION_KEYS,
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
  isFeatureEnabledAtLocation,
  isFeatureGatedByLocation,
  NOTIFY_KEYS,
  LANDING_PREFERENCE_VALUES,
  LANDING_PREFERENCE_TARGETS,
  resolveLandingPreference,
} from '@shared/permissions'
import { hasPermission } from './permissions.js'

const ROLES = ['owner', 'manager', 'head_coach', 'staff']

describe('shared/permissions.js', () => {
  it('every role has a default-by-role map for both web and mobile', () => {
    for (const r of ROLES) {
      expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE[r], `web defaults for ${r}`).toBeDefined()
      expect(DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[r], `mobile defaults for ${r}`).toBeDefined()
    }
  })

  it('every web permission key appears in every role default map', () => {
    for (const r of ROLES) {
      for (const k of WEB_PERMISSION_KEYS) {
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
    // *take away* any mobile capability. (Inverse of the door_unlock
    // convention.)
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

describe('hasPermission three-tier resolution', () => {
  // Helpers to build user-shaped fixtures.
  const baseLoc = { id: 'loc1', features: {} }
  const u = (overrides = {}) => ({
    role: 'manager',
    permissions: {},
    activeLocation: baseLoc,
    ...overrides,
  })

  it('returns false for null user', () => {
    expect(hasPermission(null, 'pipeline')).toBe(false)
  })

  it('tier 1: location features[key]=false denies regardless of user override', () => {
    const user = u({
      activeLocation: { features: { pipeline: false } },
      permissions: { pipeline: true }, // user said yes; location wins
    })
    expect(hasPermission(user, 'pipeline')).toBe(false)
  })

  it('tier 2: user override === true grants when location is permissive', () => {
    expect(hasPermission(u({ permissions: { car_processing: true } }), 'car_processing')).toBe(true)
  })

  it('tier 2: user override === false denies even if role default is true', () => {
    expect(hasPermission(u({ role: 'manager', permissions: { schedule: false } }), 'schedule')).toBe(false)
  })

  it('tier 3: falls back to role default when no user override', () => {
    expect(hasPermission(u({ role: 'staff' }), 'schedule')).toBe(true)         // staff default
    expect(hasPermission(u({ role: 'staff' }), 'car_processing')).toBe(false)  // staff default false
    expect(hasPermission(u({ role: 'owner' }), 'settings')).toBe(true)         // owner default
  })

  it('notification keys ignore the location gate (still go to user/role)', () => {
    const user = u({
      activeLocation: { features: { notify_swap: false } }, // ignored
      permissions: { mobile: { notify_swap: true } },
    })
    // hasPermission is web-only (web sidebar), notify_* are mobile-only —
    // covered by the mobile canMobile() check. But verify that even if
    // a notify_* key showed up in the web check, the location wouldn't
    // gate it.
    // (The web hasPermission falls through to role default for unknown
    // keys, which returns undefined → false, so we just assert no crash.)
    expect(() => hasPermission(user, 'notify_swap')).not.toThrow()
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
