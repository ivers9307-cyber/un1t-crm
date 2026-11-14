// SHELLYEVENTS.1 — the studios a host may say an event is HELD AT
// (race_events.venue_location_id, mig 832).
//
// A host's events live under the host's hidden anchor location, so the row's
// own location_id never says which studio the event is in. The host picks the
// studio on the event form; this module is the one rule for which studios may
// be picked and the one check the routes run before writing the link:
//
//   * a studio of the HOST's organisation (the tenancy boundary: a host must
//     never point an event, and with it the Shelly timers, at another
//     organisation's studio),
//   * active,
//   * not a host anchor (an internal label, not a place),
//   * with an address on file. A studio with no address is not a venue we can
//     print (Test Studio, at the time of writing), and the picker fills the
//     event's venue name and address from the studio.
import { logError } from '@/lib/log'

const MODULE = 'event-venue-studio'

/**
 * The studios a host of `organizationId` may pick, by name.
 * A failed read answers [] and logs: the form then offers only "somewhere
 * else", which is today's behaviour, and the host can still save.
 *
 * @returns {Promise<Array<{ id: string, name: string, address: string }>>}
 */
export async function listVenueStudios(db, organizationId) {
  if (!organizationId) return []
  const { data, error } = await db
    .from('locations')
    .select('id, name, address, is_host_anchor')
    .eq('organization_id', organizationId)
    .eq('active', true)
    .order('name')
    .limit(100)
  if (error) {
    logError(MODULE, 'studio list read failed', { organizationId, error: error.message })
    return []
  }
  return (data || [])
    .filter((l) => !l.is_host_anchor && typeof l.address === 'string' && l.address.trim())
    .map((l) => ({ id: l.id, name: String(l.name || '').trim(), address: l.address.trim() }))
}

/**
 * Judge a venue_location_id from a request body.
 *
 * @returns {Promise<{ ok: true, venueLocationId: string|null } | { ok: false, error: 'invalid_venue_studio' }>}
 *   null in = null out (held somewhere else). An id that is not one of the
 *   organisation's pickable studios is refused, and so is any id when the
 *   studio list cannot be read: an unverified link is never written.
 */
export async function judgeVenueStudio(db, { organizationId, venueLocationId }) {
  if (venueLocationId == null || venueLocationId === '') return { ok: true, venueLocationId: null }
  const studios = await listVenueStudios(db, organizationId)
  return studios.some((s) => s.id === venueLocationId)
    ? { ok: true, venueLocationId }
    : { ok: false, error: 'invalid_venue_studio' }
}
