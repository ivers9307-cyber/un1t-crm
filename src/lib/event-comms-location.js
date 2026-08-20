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
 * THIS FUNCTION NEVER THROWS. Every read failure degrades to `null`, which
 * every caller already turns into "use the event's own location".
 *
 * That is a deliberate reversal of BAREWRITE.1/.3, and the reasoning is worth
 * keeping because the same trade will come up again.
 *
 * BAREWRITE.1 made both reads THROW rather than fall through, on the theory
 * that a transient read failure could silently pick the host's sender-less
 * anchor and send under the wrong brand. The theory was sound; the price was
 * not. Every caller of this function is delivering a message a customer has
 * already paid for or asked for, and a throw costs that message outright, with
 * no retry: race-confirmations is invoked only on a FRESH payment transition
 * (`markRacePaymentStatus` returns `applied: null` once the payment is already
 * 'completed'), so a payment-provider redelivery cannot re-run it. One transient
 * blip = one paying attendee who never gets their receipt, or their check-in QR.
 *
 * BAREWRITE.3 narrowed the throw to the brand-crossing hops. BAREWRITE.4 removes
 * it, because the brand it was protecting cannot actually differ:
 *
 *   • EMAIL identity is resolved per ORGANISATION, not per location —
 *     `resolveEmailSender` → `loadLiveRowForLocation` reads the location's
 *     `organization_id` and then `tenant_email_domains` for that org. A host
 *     anchor is created with its host's `organization_id` (`ensureAnchorLocation`),
 *     and `resolveMasterLocationIdStrict` only ever returns a location inside
 *     that same org. So target and fallback are STRUCTURALLY the same email
 *     identity — not merely the same today.
 *   • SMS identity is `locations.twilio_alpha_sender_id`, falling back through
 *     `resolveSenderLocation` to the ORG's default sender when the location has
 *     none. Measured against prod on 2026-08-20: the estate has exactly one host
 *     anchor ("Pride Training Club (host events)", org UN1T Group) and its
 *     sender is `UN1T Dub` — byte-identical to its org master's (Stillorgan).
 *     The only `sending_location_id` overrides in the data point at that same
 *     Stillorgan row. There is no pair of (target, fallback) locations in prod
 *     for which the alpha sender differs.
 *
 * So the throw was trading a CERTAIN, silent, unrecoverable loss of a paying
 * customer's receipt against a wrong-brand send that cannot currently happen.
 * Removing a silent failure must not create a louder one — the win here is
 * VISIBILITY, and that is what stays: every discarded read is reported through
 * `logError` with the ids needed to act on it, at error level, so Sentinel can
 * key on it. If a future location is configured with a genuinely different
 * sender from its org master, this log is the signal that says so — and the fix
 * then is to give the anchor the right sender, not to delete the message.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {{ sending_location_id?: string|null, host_id?: string|null, location_id?: string|null }|null} event
 * @returns {Promise<object|null>} the location row to send from (twilio_sender overlaid), or null
 */
export async function resolveEventCommsLocation(db, event) {
  if (!event) return null

  // Hop 1 — the anchor's organisation, needed to find the org master.
  // Both reads below used to discard `error`, which is what BAREWRITE.1 was
  // right to object to: the tier logic FALLS THROUGH on a null, so "we could
  // not read it" and "there is no such row" collapsed into the same answer with
  // nothing recorded anywhere. They are still distinguished — the difference
  // now goes to the log instead of to a throw.
  let masterLocationId = null
  if (!event.sending_location_id && event.host_id && event.location_id) {
    const { data: anchor, error: anchorError } = await db
      .from('locations')
      .select('organization_id')
      .eq('id', event.location_id)
      .maybeSingle()
    if (anchorError) {
      logError('event-comms-location', 'anchor location read failed; sending from the event location instead of the org master', {
        err: anchorError, eventLocationId: event.location_id, hostId: event.host_id,
      })
    } else {
      // Hop 2 — the org master. `resolveMasterLocationIdStrict` is the variant
      // that surfaces a read failure instead of folding it into the anchor
      // (`resolveMasterLocationId` is HOST-MASTER.1's contact-homing helper and
      // deliberately fails open). We want the distinction — but we want it in
      // the log, not as an escaping throw, so it is caught here.
      try {
        masterLocationId = await resolveMasterLocationIdStrict(db, {
          organization_id: anchor?.organization_id || null,
          anchor_location_id: event.location_id,
        })
      } catch (e) {
        logError('event-comms-location', 'org master read failed; sending from the event location instead', {
          err: e, eventLocationId: event.location_id, organizationId: anchor?.organization_id || null,
        })
      }
    }
  }

  const targetId = pickCommsLocationTarget(event, masterLocationId)
  if (!targetId) return null

  // Hop 3 — the sending location row itself.
  const { data: row, error: rowError } = await db
    .from('locations')
    .select('id, name, twilio_alpha_sender_id, organization_id')
    .eq('id', targetId)
    .maybeSingle()
  if (rowError) {
    logError('event-comms-location', 'sending location read failed; falling back to the event location', {
      err: rowError,
      locationId: targetId,
      eventLocationId: event.location_id || null,
      // True when the fallback is a DIFFERENT row than the one we wanted. Not
      // an error condition (see the header: same org ⇒ same email identity, and
      // no prod pair differs on the SMS sender) — but it is the field to alert
      // on if that ever stops being true.
      crossesLocation: targetId !== (event.location_id || null),
    })
    return null
  }
  if (!row) return null

  return overlayConnections(db, row, ['twilio_sender'])
}
