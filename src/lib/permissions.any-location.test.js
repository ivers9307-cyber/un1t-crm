// ROLESWEEP.1 — hasPermissionAtAnyLocation: the coarse "you hold this key
// somewhere" pre-check that replaces hasPermission(user, key) in front of a
// route that judges the real target with hasPermissionForLocation.
import { describe, it, expect } from 'vitest'
import { hasPermission, hasPermissionAtAnyLocation, hasPermissionForLocation } from './permissions'
import { person, MASTER, LOC_A, LOC_B, keyOffAtB, keyOnAtBOnly, featureOffAtA } from '../../tests/helpers/role-sweep-callers.js'

describe('hasPermissionAtAnyLocation', () => {
  it('is false for no user and for a user with no locations', () => {
    expect(hasPermissionAtAnyLocation(null, 'email')).toBe(false)
    expect(hasPermissionAtAnyLocation({ locations: [] }, 'email')).toBe(false)
  })

  it('is true when the key is held at a location other than the active one', () => {
    const u = keyOnAtBOnly('email')
    expect(hasPermission(u, 'email')).toBe(false) // the active studio says no…
    expect(hasPermissionForLocation(u, LOC_B, 'email')).toBe(true)
    expect(hasPermissionAtAnyLocation(u, 'email')).toBe(true) // …B says yes
  })

  it('is true when the feature is off at the active location but on elsewhere', () => {
    expect(hasPermissionAtAnyLocation(featureOffAtA('contacts'), 'contacts')).toBe(true)
  })

  it('is false when the key is off at every location', () => {
    const u = person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'staff' } }, LOC_A)
    expect(hasPermissionAtAnyLocation(u, 'email')).toBe(false) // staff default: email off
  })

  it('never widens a single location: off at B stays off at B', () => {
    const u = keyOffAtB('sms')
    expect(hasPermissionAtAnyLocation(u, 'sms')).toBe(true)
    expect(hasPermissionForLocation(u, LOC_B, 'sms')).toBe(false)
  })

  it('scores a master per location, feature gate included', () => {
    expect(hasPermissionAtAnyLocation(MASTER, 'races')).toBe(true)
    const off = { ...MASTER, locations: MASTER.locations.map((l) => ({ ...l, features: { races: false } })) }
    expect(hasPermissionAtAnyLocation(off, 'races')).toBe(false)
  })
})
