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

// Constructs a point at exactly `meters` from `centre`, along the same
// latitude, by inverting the haversine formula algebraically (not by an
// approximation like `meters / 111320`) — used to build an exact boundary
// case for the resolver's `<=` decision without floating-point flakiness.
function pointDueEastAtDistance(centre, meters) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const toDeg = (r) => (r * 180) / Math.PI
  const latRad = toRad(centre.latitude)
  const dLonRad = 2 * Math.asin(Math.sin(meters / (2 * R)) / Math.cos(latRad))
  return { latitude: centre.latitude, longitude: centre.longitude + toDeg(dLonRad) }
}

describe('haversineMeters', () => {
  it('is ~0 for identical points and ~6.23km Stillorgan↔Hatch (falsifiable: catches a dropped cos(lat) term)', () => {
    expect(haversineMeters(STILLORGAN, STILLORGAN)).toBeLessThan(1)
    const d = haversineMeters(STILLORGAN, HATCH)
    expect(d).toBeGreaterThan(6100)
    expect(d).toBeLessThan(6350)
  })
  it('is ~150m for a point 150m due north of a centre (decision-scale case)', () => {
    const centre = { latitude: 53.30, longitude: -6.20 }
    const north = { latitude: centre.latitude + 150 / 111320, longitude: centre.longitude }
    const d = haversineMeters(centre, north)
    expect(d).toBeGreaterThan(149)
    expect(d).toBeLessThan(151)
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
  it('unknown when position coords are not finite (never coerce to 0,0)', () => {
    const r1 = resolvePhysicalLocation({ position: at({ latitude: null, longitude: undefined }), regions: REGIONS, locations: LOCATIONS })
    expect(r1.status).toBe('unknown')
    const r2 = resolvePhysicalLocation({ position: at({ latitude: NaN, longitude: HATCH.longitude }), regions: REGIONS, locations: LOCATIONS })
    expect(r2.status).toBe('unknown')
  })
  it('unknown when locations is not an array (not loaded yet ≠ assigned to nothing)', () => {
    expect(resolvePhysicalLocation({ position: at(HATCH), regions: REGIONS, locations: undefined }).status).toBe('unknown')
    expect(resolvePhysicalLocation({ position: at(HATCH), regions: REGIONS, locations: null }).status).toBe('unknown')
  })
  it('offsite (not unknown) when locations is a loaded, genuinely empty array', () => {
    const r = resolvePhysicalLocation({ position: at(HATCH), regions: REGIONS, locations: [] })
    expect(r).toEqual({ status: 'offsite', location: null })
  })
  it('resolves at_studio exactly at the boundary distance (the <= choice matches OS geofence semantics)', () => {
    const boundary = pointDueEastAtDistance(HATCH, 150)
    // Use the SAME computed distance as the region radius so the comparison
    // inside the resolver is an exact float equality, not an approximation
    // that floating-point rounding could push either side of 150.
    const exactDistance = haversineMeters(HATCH, boundary)
    const boundaryRegions = [{ location_id: 'loc-hatch', latitude: HATCH.latitude, longitude: HATCH.longitude, radius_m: exactDistance }]
    const r = resolvePhysicalLocation({ position: at(boundary), regions: boundaryRegions, locations: LOCATIONS })
    expect(r.status).toBe('at_studio')
    expect(r.location.id).toBe('loc-hatch')
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
  it('rejects a stale current, falling through to a fresh-enough lastKnown', () => {
    const nowMs = 10 * 60 * 1000
    const staleCurrent = { coords: HATCH, timestamp: 0 }
    const lastKnown = { coords: STILLORGAN, timestamp: nowMs - 1000 }
    expect(pickPosition({ current: staleCurrent, lastKnown, nowMs })).toBe(lastKnown)
  })
  it('rejects a stale current with no usable lastKnown, returning null', () => {
    const nowMs = 10 * 60 * 1000
    const staleCurrent = { coords: HATCH, timestamp: 0 }
    expect(pickPosition({ current: staleCurrent, lastKnown: null, nowMs })).toBe(null)
  })
  it('accepts a current with no timestamp unconditionally', () => {
    const current = { coords: HATCH }
    expect(pickPosition({ current, lastKnown: null, nowMs: 10 * 60 * 1000 })).toBe(current)
  })
  it('rejects a future-dated lastKnown beyond the window (a backwards clock change must not look fresh)', () => {
    const nowMs = 1000
    const lastKnown = { coords: STILLORGAN, timestamp: nowMs + 10 * 60 * 1000 }
    expect(pickPosition({ current: null, lastKnown, nowMs })).toBe(null)
  })
  it('rejects a future-dated current beyond the window, falling through to null', () => {
    const nowMs = 1000
    const futureCurrent = { coords: HATCH, timestamp: nowMs + 10 * 60 * 1000 }
    expect(pickPosition({ current: futureCurrent, lastKnown: null, nowMs })).toBe(null)
  })
})
