// TZ.12 — the zone a studio TV board draws its clocks in, for a board route
// that does not already read the location row (the cast board's content
// route). Server-only (it reads locations.timezone).
//
// The boards are DISPLAY-ONLY, so a failed zone read must never blank one:
// it falls back explicitly to DEFAULT_TZ (Europe/Dublin) with a logged
// warning, as src/lib/location-time.js prescribes for display callers. A
// decision or cron caller must not copy this: it lets LocationZoneReadError
// propagate and skips the cycle instead.

import { getLocationZone, DEFAULT_TZ } from '@/lib/location-time'
import { logWarn } from '@/lib/log'

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {string|null|undefined} locationId
 * @returns {Promise<string>} canonical IANA zone; DEFAULT_TZ when unreadable
 */
export async function boardZoneForLocation(db, locationId) {
  try {
    return await getLocationZone(db, locationId)
  } catch (err) {
    logWarn('tv', 'location zone unreadable; board clock falls back to DEFAULT_TZ', { locationId, err })
    return DEFAULT_TZ
  }
}
