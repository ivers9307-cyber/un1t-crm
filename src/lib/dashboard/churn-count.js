// CHURNONE.1 — one churn number on the Business page.
//
// The KPI card counted high-risk members LIVE (loadRadar) while the "Needs
// you" rail on the same page read last Monday's churn_radar_snapshots row,
// so the page showed two different answers to one question. Both now ask
// this: the live radar, through the same 60-second per-studio cache the
// Churn Radar pages use (radar-cache.js, scope 'churn', view 'radar'), so
// the page costs one member scan, shared with the radar tab, not two.
//
// null (never 0) when the studio's source does not supply memberships or the
// radar could not be read: the caller shows nothing rather than a false zero.

import { radarCache } from '@/lib/radar-cache'
import { loadRadar } from '@/lib/churn-radar-data'

/** The live radar, shared with /api/churn-radar's cache entry. */
export function cachedChurnRadar(db, locationId) {
  return radarCache('churn', locationId, 'radar', () => loadRadar(db, locationId))
}

/** High-risk member count from a radar result, or null. Pure. */
export function highRiskOf(radar) {
  const n = radar?.summary?.highRisk
  return Number.isFinite(n) ? n : null
}
