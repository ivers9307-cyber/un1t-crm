// The Afterglow accent rule (spec §2.2, critic-refined). The app's chrome
// accent is EARNED: the hardest zone the member sustained for >=3 minutes in
// one session over the trailing 7 days, clamped to Z3-Z5. Quiet weeks and
// Z1/Z2-only weeks rest on Pearl — a designed identity, not an absence.
// Zone-seconds objects are keyed by zone id, sometimes as strings (same
// tolerance as zoneBreakdown in shared/heart-rate.js).
import { ZONE_COLORS_DARK } from './zone-colors'

export const PEARL = '#D9D5CC'
const MIN_SECONDS = 180
const WINDOW_MS = 7 * 24 * 3600 * 1000

// Highest zone in {3,4,5} with >= MIN_SECONDS in this one session, else null.
export function hardestZone(zonesSeconds) {
  if (!zonesSeconds || typeof zonesSeconds !== 'object') return null
  for (const z of [5, 4, 3]) {
    const secs = Number(zonesSeconds[z] ?? zonesSeconds[String(z)] ?? 0) || 0
    if (secs >= MIN_SECONDS) return z
  }
  return null
}

export function accentFromSessions(sessions, nowMs) {
  const cutoff = nowMs - WINDOW_MS
  let best = null
  for (const s of sessions || []) {
    const t = Date.parse(s?.started_at)
    if (!Number.isFinite(t) || t < cutoff || t > nowMs) continue
    const z = hardestZone(s?.zones_seconds)
    if (z != null && (best == null || z > best)) best = z
  }
  return best != null
    ? { zone: best, color: ZONE_COLORS_DARK[best], lit: true }
    : { zone: null, color: PEARL, lit: false }
}
