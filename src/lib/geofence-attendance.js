// src/lib/geofence-attendance.js
//
// GEO-ATT (mig 463) — passive staff attendance via mobile geofencing.
// Location config lives in locations.settings.geofence:
//   { enabled, latitude, longitude, radius_m, gate_copy }
// This module owns defaults + normalisation (the FREQ-CAP.1 shape).

export const GEOFENCE_MIN_RADIUS_M = 50
export const GEOFENCE_MAX_RADIUS_M = 1000
const DEFAULT_RADIUS_M = 150

// GEO-ATT.19 — this string IS the Google Play "prominent disclosure" for
// background location: LocationGate renders it verbatim on a full-screen gate
// BEFORE any runtime permission prompt, and the Play declaration's review video
// shows it. Play grades three things, so the test file pins all three: the
// feature the data serves, that collection continues with the app closed, and
// an honest statement of what is NOT collected. The old wording carried the
// background clause only in the small print UNDER the button, which is the
// single most common rejection reason for this declaration.
//
// It is served from the API, not baked into the binary — so correcting it is a
// web deploy that lands on the next foreground, with no store release. Per-
// location `gate_copy` overrides it; an operator override is NOT checked
// against any of this, so review a custom one against the same three points.
export const DEFAULT_GATE_COPY =
  'Repset clocks you in for your shift when arriving at the gym. ' +
  'To do that it collects your location in the background, even when the app is closed or not in use. ' +
  'It only detects arrival at your own gym and never tracks you anywhere else.'

function finiteOrNull(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function inRangeOrNull(v, min, max) {
  const n = finiteOrNull(v)
  return n !== null && n >= min && n <= max ? n : null
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
    latitude: inRangeOrNull(g.latitude, -90, 90),
    longitude: inRangeOrNull(g.longitude, -180, 180),
    radiusM,
    gateCopy,
  }
}

/** A location only participates when enabled AND has real coordinates. */
export function geofenceIsConfigured(g) {
  return !!g && g.enabled === true && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)
}
