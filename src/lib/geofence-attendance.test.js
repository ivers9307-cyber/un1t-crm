// src/lib/geofence-attendance.test.js
import { describe, it, expect } from 'vitest'
import {
  geofenceFromLocationSettings,
  geofenceIsConfigured,
  DEFAULT_GATE_COPY,
  GEOFENCE_MIN_RADIUS_M,
  GEOFENCE_MAX_RADIUS_M,
} from './geofence-attendance.js'

// GEO-ATT.19 — Google Play's background-location declaration is graded on the
// PROMINENT DISCLOSURE the app shows before the runtime prompt, and this string
// is that disclosure's body (LocationGate renders it verbatim). Play rejects a
// disclosure that doesn't say the collection continues with the app closed, so
// these phrases are a compliance contract, not prose preference. Change the
// wording freely — but keep it saying all three of these things, or the next
// store submission bounces.
describe('DEFAULT_GATE_COPY (Play prominent-disclosure contract)', () => {
  it('states that location is collected when the app is closed or not in use', () => {
    expect(DEFAULT_GATE_COPY.toLowerCase()).toContain('closed or not in use')
  })
  // Anchored on "shift", not "attendance": the feature can be described as
  // logging attendance or clocking in, and both are honest. What Play needs is
  // that the copy says WHICH feature the location is for, and every phrasing of
  // this one is about the staffer's shift.
  it('names the feature the data is collected for', () => {
    expect(DEFAULT_GATE_COPY.toLowerCase()).toContain('shift')
  })
  it('says what is NOT collected, so the scope is honest', () => {
    expect(DEFAULT_GATE_COPY.toLowerCase()).toContain('never')
  })
})

describe('geofenceFromLocationSettings', () => {
  it('returns disabled defaults for null/missing settings', () => {
    for (const s of [null, undefined, {}, { geofence: null }]) {
      expect(geofenceFromLocationSettings(s)).toEqual({
        enabled: false, latitude: null, longitude: null,
        radiusM: 150, gateCopy: DEFAULT_GATE_COPY,
      })
    }
  })

  it('reads a fully-configured blob', () => {
    const g = geofenceFromLocationSettings({
      geofence: { enabled: true, latitude: 53.2905, longitude: -6.1988, radius_m: 200, gate_copy: 'Custom copy' },
    })
    expect(g).toEqual({ enabled: true, latitude: 53.2905, longitude: -6.1988, radiusM: 200, gateCopy: 'Custom copy' })
  })

  it('clamps radius into [GEOFENCE_MIN_RADIUS_M, GEOFENCE_MAX_RADIUS_M]', () => {
    expect(geofenceFromLocationSettings({ geofence: { radius_m: 5 } }).radiusM).toBe(GEOFENCE_MIN_RADIUS_M)
    expect(geofenceFromLocationSettings({ geofence: { radius_m: 99999 } }).radiusM).toBe(GEOFENCE_MAX_RADIUS_M)
  })

  it('rejects non-finite coordinates back to null', () => {
    const g = geofenceFromLocationSettings({ geofence: { enabled: true, latitude: 'x', longitude: Infinity } })
    expect(g.latitude).toBeNull()
    expect(g.longitude).toBeNull()
  })

  it('blank gate_copy falls back to the default', () => {
    expect(geofenceFromLocationSettings({ geofence: { gate_copy: '   ' } }).gateCopy).toBe(DEFAULT_GATE_COPY)
  })

  it('coerces string numbers and rounds the radius', () => {
    const g = geofenceFromLocationSettings({
      geofence: { latitude: '53.29', longitude: '-6.19', radius_m: '200' },
    })
    expect(g.latitude).toBe(53.29)
    expect(g.longitude).toBe(-6.19)
    expect(g.radiusM).toBe(200)
    expect(geofenceFromLocationSettings({ geofence: { radius_m: 150.6 } }).radiusM).toBe(151)
  })

  it('nulls out-of-range coordinates', () => {
    expect(geofenceFromLocationSettings({ geofence: { latitude: 999 } }).latitude).toBeNull()
  })
})

describe('geofenceIsConfigured', () => {
  it('true only when enabled with finite lat+lng', () => {
    expect(geofenceIsConfigured({ enabled: true, latitude: 53.29, longitude: -6.19, radiusM: 150 })).toBe(true)
    expect(geofenceIsConfigured({ enabled: false, latitude: 53.29, longitude: -6.19, radiusM: 150 })).toBe(false)
    expect(geofenceIsConfigured({ enabled: true, latitude: null, longitude: -6.19, radiusM: 150 })).toBe(false)
    expect(geofenceIsConfigured({ enabled: true, latitude: 53.29, longitude: null, radiusM: 150 })).toBe(false)
    expect(geofenceIsConfigured({ enabled: true, latitude: undefined, longitude: -6.19, radiusM: 150 })).toBe(false)
  })
})
