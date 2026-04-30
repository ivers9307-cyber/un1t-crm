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
  WEB_PERMISSIONS, MOBILE_PERMISSIONS,
  WEB_PERMISSION_KEYS, MOBILE_PERMISSION_KEYS,
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
} from '@shared/permissions'

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
