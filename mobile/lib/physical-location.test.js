// mobile/lib/physical-location.test.js
import { describe, it, expect } from 'vitest'
import { haversineMeters, resolvePhysicalLocation, pickPosition } from './physical-location'

const STILLORGAN = { latitude: 53.2887, longitude: -6.1970 }
const HATCH = { latitude: 53.3331, longitude: -6.2542 }
const REGIONS = [
  { location_id: 'loc-still', latitude: STILLORGAN.latitude, longitude: STILLORGAN.longitude, radius_m: 150 },
  { location_id: 'loc-hatch', latitude: HATCH.latitude, longitude: HATCH.longitude, radius_m: 150 },
]
const LOCATIONS = [{ id: 'loc-still', name: 'Stillorgan' }, { id: 'loc-hatch', name: 'Hatch Street' }]
const at = (coords) => ({ coords, timestamp: 1000 })

describe('haversineMeters', () => {
  it('is ~0 for identical points and ~7km Stillorgan↔Hatch', () => {
    expect(haversineMeters(STILLORGAN, STILLORGAN)).toBeLessThan(1)
    const d = haversineMeters(STILLORGAN, HATCH)
    expect(d).toBeGreaterThan(5000)
    expect(d).toBeLessThan(9000)
  })
})

describe('resolvePhysicalLocation', () => {
  it('at_studio inside a region, with the matching location object', () => {
    const r = resolvePhysicalLocation({ position: at(HATCH), regions: REGIONS, locations: LOCATIONS })
    expect(r.status).toBe('at_studio')
    expect(r.location.id).toBe('loc-hatch')
  })
  it('offsite when inside no region', () => {
    const r = resolvePhysicalLocation({ position: at({ latitude: 53.30, longitude: -6.22 }), regions: REGIONS, locations: LOCATIONS })
    expect(r).toEqual({ status: 'offsite', location: null })
  })
  it('unknown with no position or no regions', () => {
    expect(resolvePhysicalLocation({ position: null, regions: REGIONS, locations: LOCATIONS }).status).toBe('unknown')
    expect(resolvePhysicalLocation({ position: at(HATCH), regions: [], locations: LOCATIONS }).status).toBe('unknown')
  })
  it('unknown when overlapping regions of DIFFERENT locations both match (never guess)', () => {
    const overlapping = [
      { location_id: 'a', latitude: HATCH.latitude, longitude: HATCH.longitude, radius_m: 500 },
      { location_id: 'b', latitude: HATCH.latitude, longitude: HATCH.longitude, radius_m: 500 },
    ]
    const locs = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
    expect(resolvePhysicalLocation({ position: at(HATCH), regions: overlapping, locations: locs }).status).toBe('unknown')
  })
  it('two regions of the SAME location are fine', () => {
    const twin = [
      { location_id: 'loc-hatch', latitude: HATCH.latitude, longitude: HATCH.longitude, radius_m: 100 },
      { location_id: 'loc-hatch', latitude: HATCH.latitude, longitude: HATCH.longitude, radius_m: 300 },
    ]
    expect(resolvePhysicalLocation({ position: at(HATCH), regions: twin, locations: LOCATIONS }).status).toBe('at_studio')
  })
  it('offsite when the matched region belongs to a location not in my assignments', () => {
    const r = resolvePhysicalLocation({ position: at(HATCH), regions: REGIONS, locations: [LOCATIONS[0]] })
    expect(r).toEqual({ status: 'offsite', location: null })
  })
  it('skips malformed regions instead of coercing (absent is not zero)', () => {
    const bad = [{ location_id: 'x', latitude: null, longitude: undefined, radius_m: '150' }]
    expect(resolvePhysicalLocation({ position: at(HATCH), regions: bad, locations: LOCATIONS }).status).toBe('offsite')
  })
})

describe('pickPosition', () => {
  it('prefers a current read', () => {
    const current = at(HATCH)
    expect(pickPosition({ current, lastKnown: at(STILLORGAN), nowMs: 10_000 })).toBe(current)
  })
  it('falls back to a fresh-enough lastKnown', () => {
    const lastKnown = { coords: STILLORGAN, timestamp: 9_000 }
    expect(pickPosition({ current: null, lastKnown, nowMs: 10_000 })).toBe(lastKnown)
  })
  it('rejects a stale lastKnown (the morning-at-Stillorgan trap)', () => {
    const lastKnown = { coords: STILLORGAN, timestamp: 0 }
    expect(pickPosition({ current: null, lastKnown, nowMs: 10 * 60 * 1000 })).toBe(null)
  })
  it('rejects a lastKnown with a non-finite timestamp', () => {
    expect(pickPosition({ current: null, lastKnown: { coords: STILLORGAN, timestamp: null }, nowMs: 1000 })).toBe(null)
  })
})
