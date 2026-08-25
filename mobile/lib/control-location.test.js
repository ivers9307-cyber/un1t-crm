// mobile/lib/control-location.test.js
import { describe, it, expect } from 'vitest'
import { resolveControlLocation, pickerLocations, canPickLocation } from './control-location'

const STILL = { id: 'loc-still', name: 'Stillorgan' }
const HATCH = { id: 'loc-hatch', name: 'Hatch Street' }
const LOCATIONS = [STILL, HATCH]

describe('resolveControlLocation', () => {
  it('an explicit override wins, labelled manual', () => {
    const r = resolveControlLocation({
      overrideId: 'loc-still',
      physical: { status: 'at_studio', location: HATCH },
      activeLocation: HATCH,
      locations: LOCATIONS,
    })
    expect(r).toEqual({ location: STILL, source: 'manual' })
  })
  it('an override id not in my locations is IGNORED (deep-link hardening)', () => {
    const r = resolveControlLocation({
      overrideId: 'loc-evil',
      physical: { status: 'at_studio', location: HATCH },
      activeLocation: STILL,
      locations: LOCATIONS,
    })
    expect(r).toEqual({ location: HATCH, source: 'detected' })
  })
  it('a non-string overrideId (e.g. useLocalSearchParams string[]) is ignored, falls through to detected', () => {
    const r = resolveControlLocation({
      overrideId: ['loc-still'],
      physical: { status: 'at_studio', location: HATCH },
      activeLocation: STILL,
      locations: LOCATIONS,
    })
    expect(r).toEqual({ location: HATCH, source: 'detected' })
  })
  it('detected physical location beats activeLocation', () => {
    const r = resolveControlLocation({
      overrideId: null,
      physical: { status: 'at_studio', location: HATCH },
      activeLocation: STILL,
      locations: LOCATIONS,
    })
    expect(r).toEqual({ location: HATCH, source: 'detected' })
  })
  it('offsite/unknown/loading fall back to activeLocation, labelled manual', () => {
    for (const status of ['offsite', 'unknown', 'loading']) {
      const r = resolveControlLocation({
        overrideId: null,
        physical: { status, location: null },
        activeLocation: STILL,
        locations: LOCATIONS,
      })
      expect(r).toEqual({ location: STILL, source: 'manual' })
    }
  })
  it('a non-at_studio status is never treated as detected, even carrying a location', () => {
    const r = resolveControlLocation({
      overrideId: null,
      physical: { status: 'offsite', location: HATCH },
      activeLocation: STILL,
      locations: LOCATIONS,
    })
    expect(r).toEqual({ location: STILL, source: 'manual' })
  })
  it('at_studio with no physical.location falls back to activeLocation, labelled manual', () => {
    const r = resolveControlLocation({
      overrideId: null,
      physical: { status: 'at_studio', location: null },
      activeLocation: STILL,
      locations: LOCATIONS,
    })
    expect(r).toEqual({ location: STILL, source: 'manual' })
  })
  it('nothing at all → null location, manual (exercises the activeLocation undefined → null normalisation)', () => {
    const r = resolveControlLocation({ overrideId: null, physical: { status: 'unknown', location: null }, activeLocation: undefined, locations: [] })
    expect(r).toEqual({ location: null, source: 'manual' })
  })
})

describe('pickerLocations', () => {
  it('filters to locations where the perm key resolves true', () => {
    // master short-circuits canMobile to true everywhere — cheapest real fixture.
    const master = { role: 'master', permissions: {} }
    expect(pickerLocations(master, LOCATIONS, 'device_control').map(l => l.id)).toEqual(['loc-still', 'loc-hatch'])
    expect(pickerLocations(null, LOCATIONS, 'device_control')).toEqual([])
  })
  it('excludes a location where the perm key resolves false (staff, device_control off by default)', () => {
    // shared/permissions.js: staff role default has device_control: false,
    // and device_control is a CROSS_PLATFORM_KEY so canMobile routes it
    // through canDashboard/DEFAULT_WEB_PERMISSIONS_BY_ROLE — no override
    // on either location, so tier 3 (role default) decides.
    const staff = { role: 'staff', permissions: {} }
    expect(pickerLocations(staff, LOCATIONS, 'device_control')).toEqual([])
  })
  it('resolves PER-LOCATION on a tier-2 per-user override (proves the filter actually consults each location, not just role)', () => {
    const staff = { role: 'staff' }
    const locs = [
      { id: 'loc-still', features: {}, permissions: { device_control: true }, roleTemplate: {} },
      { id: 'loc-hatch', features: {}, permissions: {}, roleTemplate: {} },
    ]
    expect(pickerLocations(staff, locs, 'device_control').map(l => l.id)).toEqual(['loc-still'])
  })
  it('resolves PER-LOCATION on the tier-1 location feature gate — the one tier even master does not bypass', () => {
    const master = { role: 'master' }
    const gated = [
      { id: 'loc-still', features: { device_control: false }, permissions: {}, roleTemplate: {} },
      { id: 'loc-hatch', features: {}, permissions: {}, roleTemplate: {} },
    ]
    expect(pickerLocations(master, gated, 'device_control').map(l => l.id)).toEqual(['loc-hatch'])
  })
  it('locations undefined (profile present) → [] without throwing', () => {
    const master = { role: 'master' }
    expect(pickerLocations(master, undefined, 'device_control')).toEqual([])
  })
})

describe('canPickLocation', () => {
  it('more than one pickable location → true', () => {
    expect(canPickLocation(LOCATIONS, 'loc-still')).toBe(true)
  })
  it('exactly one pickable location that differs from the resolved one → true (the stranded-coach case: holds device_control at one studio, resolved location is another)', () => {
    expect(canPickLocation([HATCH], 'loc-still')).toBe(true)
  })
  it('exactly one pickable location that IS the resolved one → false (nothing to switch to)', () => {
    expect(canPickLocation([STILL], 'loc-still')).toBe(false)
  })
  it('no pickable locations → false', () => {
    expect(canPickLocation([], 'loc-still')).toBe(false)
  })
})
