// src/lib/geofence-attendance.test.js
import { describe, it, expect } from 'vitest'
import {
  geofenceFromLocationSettings,
  geofenceIsConfigured,
  DEFAULT_GATE_COPY,
  GEOFENCE_MIN_RADIUS_M,
  GEOFENCE_MAX_RADIUS_M,
} from './geofence-attendance.js'

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
})

describe('geofenceIsConfigured', () => {
  it('true only when enabled with finite lat+lng', () => {
    expect(geofenceIsConfigured({ enabled: true, latitude: 53.29, longitude: -6.19, radiusM: 150 })).toBe(true)
    expect(geofenceIsConfigured({ enabled: false, latitude: 53.29, longitude: -6.19, radiusM: 150 })).toBe(false)
    expect(geofenceIsConfigured({ enabled: true, latitude: null, longitude: -6.19, radiusM: 150 })).toBe(false)
  })
})
