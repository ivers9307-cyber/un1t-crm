// mobile/lib/physical-location.js
//
// HOME-LOC.2 — pure resolution of "which studio is this phone standing in".
// NO native imports — vitest runs this in Node (the geofence-permission.js
// rule). The hook in use-physical-location.js feeds it expo-location reads
// and the geofence-config regions.
//
// Region shape: { location_id, latitude, longitude, radius_m } — the
// geofence-config route's `all_regions` (exemption-blind; the attendance
// `regions` list would silently exclude geofence_exempt staff).
// Position shape: expo-location's { coords: { latitude, longitude }, timestamp }.

const EARTH_RADIUS_M = 6371000

export function haversineMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s))
}

/**
 * @returns {{ status: 'unknown'|'offsite'|'at_studio', location: object|null }}
 *
 * 'unknown'  — cannot tell (no position, no regions): render the offsite
 *              layout, never an error.
 * 'offsite'  — position resolved, inside no assigned studio's region.
 * 'at_studio'— inside exactly ONE assigned location's region(s). Overlapping
 *              regions of DIFFERENT locations resolve to 'unknown' — a wrong
 *              guess here is the exact bug this feature exists to kill.
 */
export function resolvePhysicalLocation({ position, regions, locations }) {
  // Absent is not zero — a non-finite position coord must not coerce to
  // (0,0) and silently resolve against the Gulf of Guinea. `locations` not
  // being an array (still loading, or the caller forgot to pass it) is
  // ALSO unknown, not offsite — "not loaded yet" is not "assigned to
  // nothing"; a genuinely loaded, empty array proceeds and can still land
  // on 'offsite' below.
  if (
    !position?.coords ||
    !Number.isFinite(position.coords.latitude) ||
    !Number.isFinite(position.coords.longitude) ||
    !Array.isArray(regions) ||
    regions.length === 0 ||
    !Array.isArray(locations)
  ) {
    return { status: 'unknown', location: null }
  }
  const hitIds = new Set()
  for (const r of regions) {
    // Absent is not zero — a null latitude must skip the region, not
    // coerce to the Gulf of Guinea.
    if (!Number.isFinite(r?.latitude) || !Number.isFinite(r?.longitude) || !Number.isFinite(r?.radius_m)) continue
    // `<=` (not `<`) matches OS geofence semantics (iOS/Android both treat
    // the boundary radius itself as inside the region).
    if (haversineMeters(position.coords, r) <= r.radius_m) hitIds.add(r.location_id)
  }
  if (hitIds.size === 0) return { status: 'offsite', location: null }
  if (hitIds.size > 1) return { status: 'unknown', location: null }
  const id = hitIds.values().next().value
  // `locations` is guaranteed an array by the guard above.
  const location = locations.find((l) => l.id === id) || null
  if (!location) return { status: 'offsite', location: null }
  return { status: 'at_studio', location }
}

const LAST_KNOWN_MAX_AGE_MS = 5 * 60 * 1000

/**
 * Prefer a fresh read; fall back to lastKnown only when recent. A stale
 * lastKnown is worse than none: this morning's studio must not paint as
 * "detected" this afternoon.
 *
 * `current` gets the same staleness gate as `lastKnown` WHEN it carries a
 * finite timestamp — a `current` read is not guaranteed fresh just because
 * it is called "current" (a queued/replayed read, or a caller passing
 * through an old sample under this name, would otherwise bypass the gate
 * entirely). A `current` with no timestamp at all is accepted
 * unconditionally: expo-location's live reads always carry one, so a
 * missing timestamp means the caller is not asserting an age, not that the
 * read is old — there is nothing to gate against.
 *
 * Both checks use `Math.abs(nowMs - timestamp)` so a backwards clock change
 * (or a wall-clock's `timestamp` briefly ahead of `nowMs`, e.g. Date.now()
 * jitter) can't make a stale or future-dated fix look fresh.
 */
export function pickPosition({ current, lastKnown, nowMs, maxAgeMs = LAST_KNOWN_MAX_AGE_MS }) {
  if (current?.coords) {
    if (!Number.isFinite(current.timestamp) || Math.abs(nowMs - current.timestamp) <= maxAgeMs) {
      return current
    }
  }
  if (
    lastKnown?.coords &&
    Number.isFinite(lastKnown.timestamp) &&
    Math.abs(nowMs - lastKnown.timestamp) <= maxAgeMs
  ) {
    return lastKnown
  }
  return null
}
