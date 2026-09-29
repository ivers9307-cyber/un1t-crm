// Resolve the real UN1T location whose email identity an event's outbound
// comms should use. Hosted events sit on a sender-less per-host anchor
// location; this returns the org master (or an explicit per-event override)
// instead, so email (resolveEmailSender) sends from a real location. It used
// to pick the SMS sender too, until SMS was retired with Twilio
// (TWILIO-RETIRE.1). See spec 2026-08-18-event-comms-location-design.md.

import { resolveMasterLocationIdStrict } from './host-events'
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
 * Is this location row an OPS-ONLY anchor whose name must never be shown to a
 * customer?
 *
 * `ensureAnchorLocation` (host-events.js) mints exactly one hidden location per
 * host, named `"<host> (host events)"` and flagged `is_host_anchor`. It is a
 * bookkeeping row — it holds a host's events so they can hang off a location —
 * and its name is an internal label, not a venue. In prod today one such row
 * exists and two ACTIVE upcoming events sit on it.
 *
 * The flag is the real test. The name suffix is a second, deliberately
 * redundant one: this predicate is called from three different modules, each
 * with its own hand-written `select()`, and a select that forgets
 * `is_host_anchor` would otherwise silently re-open the exact defect. A false
 * positive costs a blank venue line; a false negative shows a customer an
 * internal string. Prefer the blank.
 *
 * Pure.
 *
 * @param {{ is_host_anchor?: boolean|null, name?: string|null }|null|undefined} location
 * @returns {boolean}
 */
export function isHostAnchorLocation(location) {
  if (!location) return false
  if (location.is_host_anchor === true) return true
  return typeof location.name === 'string' && /\(host events\)\s*$/i.test(location.name.trim())
}

/** First non-anchor, non-empty `name` among the given location rows. */
function firstPublicLocationName(locations) {
  for (const loc of locations) {
    if (isHostAnchorLocation(loc)) continue
    const name = typeof loc?.name === 'string' ? loc.name.trim() : ''
    if (name) return name
  }
  return ''
}

/**
 * WHERE THE EVENT IS. The factual venue claim: the email "Where" row, the
 * `{{location}}` merge tag operators write copy against, the public signup
 * page's venue line.
 *
 * Order: the event's own venue name → the event's OWN location → ''.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE COMMS LOCATION IS NOT IN THIS LIST
 * ─────────────────────────────────────────────────────────────────────────
 * It was, in the first cut of this change, and that was a new bug wearing the
 * old one's clothes. `resolveEventCommsLocation` answers "whose email identity
 * does this event send under" — mig 553 defines `sending_location_id`
 * as exactly that, an identity override, explicitly NOT a venue. For a host
 * event with no `sending_location_id` it resolves to the ORG MASTER, a real gym
 * the attendee may never have heard of.
 *
 * So ranking it above the event's own location meant: an operator repoints a
 * Hatch Street event's SENDING identity at Stillorgan for deliverability, and
 * the attendee's "Where" row silently changes from Hatch Street to Stillorgan —
 * a confident, specific, wrong address someone may travel to. The defect this
 * whole change exists to fix ("<host> (host events)") is at least self-evidently
 * not a venue; this one is not. An OMITTED "Where" row is strictly better than a
 * wrong one, and every call site renders '' as "omit this line".
 *
 * Pure.
 *
 * @param {object} args
 * @param {string|null|undefined} args.venueName       race_events.venue_name
 * @param {object|null|undefined} args.eventLocation   the event's own location row
 * @returns {string} a customer-safe venue name, or '' when there is none
 */
export function pickAudienceVenueName({ venueName, eventLocation } = {}) {
  const venue = typeof venueName === 'string' ? venueName.trim() : ''
  if (venue) return venue
  return firstPublicLocationName([eventLocation])
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
 * it, because the brand it was protecting cannot actually differ: EMAIL identity
 * is resolved per ORGANISATION, not per location — `resolveEmailSender` →
 * `loadLiveRowForLocation` reads the location's `organization_id` and then
 * `tenant_email_domains` for that org. A host anchor is created with its host's
 * `organization_id` (`ensureAnchorLocation`), and `resolveMasterLocationIdStrict`
 * only ever returns a location inside that same org. So target and fallback are
 * STRUCTURALLY the same email identity — not merely the same today.
 *
 * (The SMS alpha sender was the per-LOCATION half of this argument, and it DID
 * differ inside one org — Hatch `UN1THATCH` vs Stillorgan `UN1T Dub`. It left
 * with the SMS channel in TWILIO-RETIRE.1, and with it the `crossesLocation`
 * log field that existed to catch a fallback changing the SMS brand.)
 *
 * So the throw was trading a CERTAIN, silent, unrecoverable loss of a paying
 * customer's receipt against a wrong-brand send that cannot happen.
 * Removing a silent failure must not create a louder one — the win here is
 * VISIBILITY, and that is what stays: every discarded read is reported through
 * `logError` with the ids needed to act on it, at error level, so Sentinel can
 * key on it.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {{ sending_location_id?: string|null, host_id?: string|null, location_id?: string|null }|null} event
 * @returns {Promise<object|null>} the location row to send from, or null
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
    // `is_host_anchor` is here for pickAudienceVenueName, not for sending:
    // an explicit `sending_location_id` CAN legitimately resolve to an anchor,
    // and that is still the right row to send from — it is only the NAME that
    // must never reach a customer.
    .select('id, name, is_host_anchor, organization_id')
    .eq('id', targetId)
    .maybeSingle()
  if (rowError) {
    logError('event-comms-location', 'sending location read failed; falling back to the event location', {
      err: rowError,
      locationId: targetId,
      eventLocationId: event.location_id || null,
    })
    return null
  }
  return row || null
}
