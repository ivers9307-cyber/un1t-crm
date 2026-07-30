// src/lib/geofence-attendance.js
//
// GEO-ATT (mig 460) — passive staff attendance via mobile geofencing.
// Location config lives in locations.settings.geofence:
//   { enabled, latitude, longitude, radius_m, gate_copy }
// This module owns defaults + normalisation (the FREQ-CAP.1 shape).

export const GEOFENCE_MIN_RADIUS_M = 50
export const GEOFENCE_MAX_RADIUS_M = 1000
const DEFAULT_RADIUS_M = 150

export const DEFAULT_GATE_COPY =
  'This app records when you arrive at the gym so your shift attendance is logged automatically. ' +
  'Only your arrival at the gym is detected — the app never tracks where you are anywhere else. ' +
  'To use the app, allow location access set to "Always".'

function finiteOrNull(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/**
 * Normalise locations.settings.geofence into a fully-defaulted object.
 * Never throws; garbage in → disabled defaults out.
 * @param {object|null} settings  the locations.settings JSONB value
 * @returns {{enabled: boolean, latitude: number|null, longitude: number|null, radiusM: number, gateCopy: string}}
 */
export function geofenceFromLocationSettings(settings) {
  const g = (settings && typeof settings === 'object' && settings.geofence && typeof settings.geofence === 'object')
    ? settings.geofence : {}
  const radiusRaw = finiteOrNull(g.radius_m)
  const radiusM = radiusRaw === null
    ? DEFAULT_RADIUS_M
    : Math.min(GEOFENCE_MAX_RADIUS_M, Math.max(GEOFENCE_MIN_RADIUS_M, Math.round(radiusRaw)))
  const gateCopy = (typeof g.gate_copy === 'string' && g.gate_copy.trim()) ? g.gate_copy.trim() : DEFAULT_GATE_COPY
  return {
    enabled: g.enabled === true,
    latitude: finiteOrNull(g.latitude),
    longitude: finiteOrNull(g.longitude),
    radiusM,
    gateCopy,
  }
}

/** A location only participates when enabled AND has real coordinates. */
export function geofenceIsConfigured(g) {
  return !!g && g.enabled === true && g.latitude !== null && g.longitude !== null
}
