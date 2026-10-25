// move-locations — the studios a CUSTOMER's entry may move to (EVENT-MOVE.6/.7).
//
// A move may cross studios but never organisations: every studio of the
// entry's organisation, or the entry's studio alone when it has none. Lifted
// from src/lib/agent/event-move-tools.js (Mia's list_event_move_options) so
// the public entry routes fence the same way. Re-exported by
// registration-move.js; kept in its own small module so the agent tools can
// import it without loading the move's server chain (and without tripping
// their mocked registration-move in tests).
//
// Staff and host callers do not use this: staff are fenced by
// getUserLocationIds, hosts by their own events.

import { logWarn } from './log'

/**
 * @param {object} db  service-role client
 * @param {string} locationId  the entry's (source event's) studio
 * @param {{ organizationId?: string|null }} [opts]  the studio's organisation
 *   when the caller already read it (null = none); omitted, it is read here
 * @returns {Promise<string[]|null>} location ids, or null when a read failed
 *   (the caller fails closed)
 */
export async function moveLocationIds(db, locationId, { organizationId } = {}) {
  if (!locationId) return null
  let orgId = organizationId
  if (orgId === undefined) {
    const { data: loc, error } = await db.from('locations').select('organization_id').eq('id', locationId).maybeSingle()
    if (error) {
      logWarn('move-locations', 'location read failed; no move targets offered', { err: error, locationId })
      return null
    }
    orgId = loc?.organization_id || null
  }
  if (!orgId) return [locationId]
  const { data: rows, error: orgErr } = await db.from('locations')
    .select('id')
    .eq('organization_id', orgId)
    .order('id')
    .limit(200)
  if (orgErr) {
    logWarn('move-locations', 'organisation locations read failed; no move targets offered', { err: orgErr, locationId, organizationId: orgId })
    return null
  }
  const ids = (rows || []).map((r) => r.id).filter(Boolean)
  return ids.includes(locationId) ? ids : [locationId, ...ids]
}
