// Resolve the real UN1T location whose Twilio + email identity an event's
// outbound comms should use. Hosted events sit on a sender-less per-host anchor
// location; this returns the org master (or an explicit per-event override)
// instead, so BOTH sms (sendLocationSms) and email (resolveEmailSender) send
// from a real location. See spec 2026-08-18-event-comms-location-design.md.

import { resolveMasterLocationId } from './host-events'
import { overlayConnections } from './connection-registry'

/**
 * Pure tier logic: which location id an event's comms should use.
 * override -> host event's org master -> the event's own location.
 * @param {{ sending_location_id?: string|null, host_id?: string|null, location_id?: string|null }|null} event
 * @param {string|null} masterLocationId
 * @returns {string|null}
 */
export function pickCommsLocationTarget(event, masterLocationId) {
  if (!event) return null
  if (event.sending_location_id) return event.sending_location_id
  if (event.host_id) return masterLocationId || event.location_id || null
  return event.location_id || null
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {{ sending_location_id?: string|null, host_id?: string|null, location_id?: string|null }|null} event
 * @returns {Promise<object|null>} the location row to send from (twilio_sender overlaid), or null
 */
export async function resolveEventCommsLocation(db, event) {
  if (!event) return null

  let masterLocationId = null
  if (!event.sending_location_id && event.host_id && event.location_id) {
    const { data: anchor } = await db
      .from('locations')
      .select('organization_id')
      .eq('id', event.location_id)
      .maybeSingle()
    masterLocationId = await resolveMasterLocationId(db, {
      organization_id: anchor?.organization_id || null,
      anchor_location_id: event.location_id,
    })
  }

  const targetId = pickCommsLocationTarget(event, masterLocationId)
  if (!targetId) return null

  const { data: row } = await db
    .from('locations')
    .select('id, name, twilio_alpha_sender_id, organization_id')
    .eq('id', targetId)
    .maybeSingle()
  if (!row) return null

  return overlayConnections(db, row, ['twilio_sender'])
}
