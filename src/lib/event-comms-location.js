// Resolve the real UN1T location whose Twilio + email identity an event's
// outbound comms should use. Hosted events sit on a sender-less per-host anchor
// location; this returns the org master (or an explicit per-event override)
// instead, so BOTH sms (sendLocationSms) and email (resolveEmailSender) send
// from a real location. See spec 2026-08-18-event-comms-location-design.md.

import { resolveMasterLocationIdStrict } from './host-events'
import { overlayConnections } from './connection-registry'
import { logError } from './log'

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

  // BAREWRITE.1 — both reads below used to discard `error`, which is a real
  // problem HERE (unlike a plain lookup) because the tier logic FALLS THROUGH
  // on a null: a transient failure on the anchor read makes masterLocationId
  // null, and pickCommsLocationTarget then quietly hands back the host's
  // sender-less anchor location instead of the org master — the wrong-brand
  // sender. "We could not read it" and "there is no such row" must not
  // collapse into the same fall-through, so an error throws and the caller
  // keeps its existing send-failed handling rather than sending as the wrong
  // brand. (`.maybeSingle()` stays: 0 rows IS a legitimate answer here, so
  // this is the "answer it in the code" fix, not a discarded error.)
  //
  // BAREWRITE.3 — but ONLY where fail-open could cross a brand. The throw is
  // paid for by the message that does not go out, so it has to buy something:
  // on the anchor read below it does (the fallback is the sender-less anchor),
  // and on the target read it does only when the target differs from the
  // event's own location — see the long note at that read.
  //
  // The MIDDLE hop matters just as much: `resolveMasterLocationId` is
  // HOST-MASTER.1's contact-homing helper and deliberately fails OPEN to the
  // anchor, which for sender selection is exactly the wrong-brand fallback
  // this function exists to prevent. Call the strict variant, which throws.
  let masterLocationId = null
  if (!event.sending_location_id && event.host_id && event.location_id) {
    const { data: anchor, error: anchorError } = await db
      .from('locations')
      .select('organization_id')
      .eq('id', event.location_id)
      .maybeSingle()
    if (anchorError) {
      throw new Error(`resolveEventCommsLocation: anchor location read failed (would have fallen back to a wrong-brand sender): ${anchorError.message}`)
    }
    masterLocationId = await resolveMasterLocationIdStrict(db, {
      organization_id: anchor?.organization_id || null,
      anchor_location_id: event.location_id,
    })
  }

  const targetId = pickCommsLocationTarget(event, masterLocationId)
  if (!targetId) return null

  const { data: row, error: rowError } = await db
    .from('locations')
    .select('id, name, twilio_alpha_sender_id, organization_id')
    .eq('id', targetId)
    .maybeSingle()
  if (rowError) {
    // BAREWRITE.3 — fail CLOSED only where failing open could cross a BRAND.
    //
    // BAREWRITE.1 made this read throw for every event, which over-charged for
    // the guarantee. Every caller treats a null return the same way: it falls
    // back to the event's own `location_id` (race-confirmations
    // `commsLocation?.id || payment.race.location_id` and `commsLocation ||
    // race.locations`; payment-sms `commsLocation || reg.race_events.locations`;
    // event-attendee-reminders `commsLocation?.id || ev.location_id`). So when
    // the target we could not read IS `event.location_id`, the fallback resolves
    // to the SAME location — the same Twilio sender, the same email identity,
    // the same brand — and the throw buys nothing while costing a paying
    // attendee their receipt. Plain (non-host, no-override) events are exactly
    // that case, and they are the overwhelming majority.
    //
    // When the target DIFFERS from `event.location_id` — a host event resolved
    // to its org master, or an explicit `sending_location_id` override — the
    // fallback is a different location than the one that was chosen, which is
    // the wrong-brand send this function exists to prevent. That still throws.
    if (targetId !== event.location_id) {
      throw new Error(`resolveEventCommsLocation: sending location read failed for ${targetId} (falling back to the event's own location ${event.location_id || 'none'} would send under a different brand): ${rowError.message}`)
    }
    logError('event-comms-location', 'sending location read failed; falling back to the event location (same id, same brand)', {
      err: rowError, locationId: targetId,
    })
    return null
  }
  if (!row) return null

  return overlayConnections(db, row, ['twilio_sender'])
}
