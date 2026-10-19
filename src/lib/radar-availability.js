// UN1TRADAR.1 — may this location's radar read APIs answer with data?
//
// The radar pages already gate on the memberships capability; the read APIs
// (/api/churn-radar*, /api/lead-radar*, /api/mobile/radar, the today-feed
// churn row) did not, so at a source without membership data they computed
// Glofox-shaped zeros. They now ask this first: while the location's PROVIDER
// lacks `memberships` (the static capability, as radarReadsFor reports it)
// they answer RADAR_UNAVAILABLE and log one structured skip. Otherwise the
// response gains `source` and `dataAsOf` BESIDE `data` (never inside it, so a
// Glofox studio's `data` JSON is byte-identical): `dataAsOf` is the newest
// successful un1t.online sync at the location, so the page can say how fresh
// its numbers are; null for any other source.
import { logInfo } from '@/lib/log'
import { radarReadsFor } from '@/lib/membership/reads/index'
import { getLocationZone } from '@/lib/location-time'

export const RADAR_UNAVAILABLE = Object.freeze({ success: true, data: null, unavailable: 'memberships' })

/**
 * The newest `finished_at` of an `ok` un1t_sync_runs row at the location, or
 * null (no run yet, or an unreadable read: the freshness line is just not
 * drawn; integration health owns a stalled sync).
 */
export async function syncDataAsOf(db, locationId) {
  const { data, error } = await db
    .from('un1t_sync_runs')
    .select('finished_at')
    .eq('location_id', locationId)
    .eq('status', 'ok')
    .not('finished_at', 'is', null)
    .order('finished_at', { ascending: false })
    .limit(1)
  if (error) return null
  return data?.[0]?.finished_at ?? null
}

/**
 * @param {object} db  service-role client
 * @param {string} locationId
 * @param {{ module: string, withZone?: boolean }} opts  the log module ('churn-radar' | 'lead-radar' | …);
 *   withZone: also read the studio's zone for the "as of HH:MM" line (only
 *   the radar page's own route draws it)
 * @returns {Promise<{ available: boolean, source: string|null, dataAsOf: string|null, dataAsOfZone?: string|null }>}
 *   Throws when the source key is unreadable (MEMBERSHIP_SOURCE_UNREADABLE).
 */
export async function radarAvailability(db, locationId, { module, withZone = false }) {
  const { source, providesMemberships } = await radarReadsFor(db, locationId)
  if (!providesMemberships) {
    logInfo(module, 'radar skipped: source lacks memberships', { locationId, source })
    return { available: false, source, dataAsOf: null, dataAsOfZone: null }
  }
  if (source !== 'un1t_online') return { available: true, source, dataAsOf: null, dataAsOfZone: null }
  const dataAsOf = await syncDataAsOf(db, locationId)
  // UN1TRADAR.2 — the studio's clock for the "as of HH:MM" line; an unreadable
  // zone is null and the page then draws no line rather than guess one.
  let dataAsOfZone = null
  try { dataAsOfZone = withZone && dataAsOf ? await getLocationZone(db, locationId) : null } catch { dataAsOfZone = null }
  return { available: true, source, dataAsOf, dataAsOfZone }
}
