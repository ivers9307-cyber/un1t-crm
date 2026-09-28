// ROLESWEEP.1c — hasMobilePermissionForLocation (the per-location twin of
// hasMobilePermission) and hasMobilePermissionAtAnyLocation (its coarse
// "anywhere" pre-check). Each tier of the shared resolver is exercised AT the
// target location, never at the active one.
import { describe, it, expect } from 'vitest'
import {
  hasMobilePermission,
  hasMobilePermissionForLocation,
  hasMobilePermissionAtAnyLocation,
} from './permissions'
import { person, MASTER, ORG, LOC_A, LOC_B } from '../../tests/helpers/role-sweep-callers.js'

describe('hasMobilePermissionForLocation', () => {
  it('is false for no user, no location, or a location the caller has no role at', () => {
    const u = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
    expect(hasMobilePermissionForLocation(null, LOC_A, 'email')).toBe(false)
    expect(hasMobilePermissionForLocation(u, null, 'email')).toBe(false)
    expect(hasMobilePermissionForLocation(u, LOC_B, 'email')).toBe(false)
  })

  it('tier 3: the code default for the role AT THE TARGET, not the active role', () => {
    // staff at A (active), manager at B. Mobile defaults: staff email off, manager on.
    const u = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'manager' } }, LOC_A)
    expect(hasMobilePermission(u, 'email')).toBe(false) // the active studio says no…
    expect(hasMobilePermissionForLocation(u, LOC_B, 'email')).toBe(true) // …B says yes
    expect(hasMobilePermissionForLocation(u, LOC_A, 'email')).toBe(false)
  })

  it('tier 2: the per-location .mobile override at the target wins over the default', () => {
    const u = person({
      [LOC_A]: { role: 'owner', permissions: { mobile: { sms: true } } },
      [LOC_B]: { role: 'owner', permissions: { mobile: { sms: false } } },
    }, LOC_A)
    expect(hasMobilePermission(u, 'sms')).toBe(true)
    expect(hasMobilePermissionForLocation(u, LOC_B, 'sms')).toBe(false)
    expect(hasMobilePermissionForLocation(u, LOC_A, 'sms')).toBe(true)
  })

  it('tier 2 reads the MOBILE bag only — a web override does not leak into it', () => {
    const u = person({ [LOC_B]: { role: 'staff', permissions: { email: true } } }, LOC_B)
    expect(hasMobilePermissionForLocation(u, LOC_B, 'email')).toBe(false)
  })

  it('tier 2.5: the role template AT THE TARGET (.mobile half) beats the default', () => {
    const u = person({
      [LOC_A]: { role: 'staff' },
      [LOC_B]: { role: 'staff', template: { email: false, mobile: { email: true } } },
    }, LOC_A)
    expect(hasMobilePermissionForLocation(u, LOC_B, 'email')).toBe(true)
    expect(hasMobilePermissionForLocation(u, LOC_A, 'email')).toBe(false)
  })

  it('tier 1: the TARGET location\'s feature gate binds, whatever the active one says', () => {
    const u = person({
      [LOC_A]: { role: 'owner' },
      [LOC_B]: { role: 'owner', features: { whatsapp: false } },
    }, LOC_A)
    expect(hasMobilePermission(u, 'whatsapp')).toBe(true)
    expect(hasMobilePermissionForLocation(u, LOC_B, 'whatsapp')).toBe(false)
  })

  it('a master passes once the target location\'s feature gate is open, and not otherwise', () => {
    expect(hasMobilePermissionForLocation(MASTER, LOC_B, 'tv_displays')).toBe(true)
    const off = { ...MASTER, locations: [{ id: LOC_B, organization_id: ORG, active: true, features: { tv_displays: false } }] }
    expect(hasMobilePermissionForLocation(off, LOC_B, 'tv_displays')).toBe(false)
  })
})

describe('hasMobilePermissionAtAnyLocation', () => {
  it('is false for no user and for a user with no locations', () => {
    expect(hasMobilePermissionAtAnyLocation(null, 'email')).toBe(false)
    expect(hasMobilePermissionAtAnyLocation({ locations: [] }, 'email')).toBe(false)
  })

  it('is true when the toggle is on only at a non-active location', () => {
    const u = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'head_coach' } }, LOC_A)
    expect(hasMobilePermission(u, 'sms')).toBe(false)
    expect(hasMobilePermissionAtAnyLocation(u, 'sms')).toBe(true)
  })

  it('is false when the toggle is off everywhere', () => {
    const u = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'owner', permissions: { mobile: { email: false } } } }, LOC_A)
    expect(hasMobilePermissionAtAnyLocation(u, 'email')).toBe(false)
  })
})

// ROLESWEEP.1c review — for a caller with ONE location (the active one), the
// per-location form must answer exactly what hasMobilePermission answers:
// the only thing it may change is WHICH studio it asks, never the answer at
// the same studio. Roles × keys × a .mobile override, a .mobile template, a
// web-only override (must not leak) and a feature switched off.
describe('hasMobilePermissionForLocation at the only (active) location = hasMobilePermission', () => {
  const ROLES = ['owner', 'manager', 'head_coach', 'reception', 'staff']
  const KEYS = ['email', 'sms', 'whatsapp', 'tv_displays', 'consultations', 'pipeline']
  const COMBOS = [
    ['defaults only', {}],
    ['.mobile override on', { permissions: { mobile: { email: true, sms: true, pipeline: true } } }],
    ['.mobile override off', { permissions: { mobile: { email: false, whatsapp: false, tv_displays: false } } }],
    ['web override only', { permissions: { email: true, sms: false, consultations: false } }],
    ['.mobile template', { template: { mobile: { email: true, whatsapp: false, consultations: true } } }],
    ['template and override disagree', { template: { mobile: { sms: false } }, permissions: { mobile: { sms: true } } }],
    ['feature off', { features: { whatsapp: false, email: false, pipeline: false } }],
  ]

  for (const role of ROLES) {
    for (const [label, extra] of COMBOS) {
      it(`${role}, ${label}`, () => {
        const u = person({ [LOC_A]: { role, ...extra } }, LOC_A)
        for (const key of KEYS) {
          expect([key, hasMobilePermissionForLocation(u, LOC_A, key)])
            .toEqual([key, hasMobilePermission(u, key)])
        }
      })
    }
  }
})
