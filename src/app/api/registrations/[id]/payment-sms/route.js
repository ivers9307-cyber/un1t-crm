// POST /api/registrations/[id]/payment-sms — text a pending registrant
// their payment link.
//
// The link points at our own /event-pay/[paymentId] page (which mounts
// the right embedded checkout — Revolut or Stripe — for the event's
// provider), NOT a provider-hosted URL. Stripe Connect events have no
// hosted URL at all (embedded checkout), so the app link is the only
// provider-agnostic option.
//
// Sibling of the race-control "Payment link" copy button: instead of
// copying the link to the clipboard for the operator to paste
// somewhere, this sends it straight to the registrant over the
// platform's Twilio sender (sendLocationSms — per-location alpha
// sender, one-way). Mirrors /api/contacts/[id]/sms for the send +
// activity-log shape.
//
// Authorization:
//   - Authenticated, MANAGER_ROLES at the race's location.
//   - 'races' feature enabled at that location.
//   - Caller assigned to the race's location (IDOR — 404 not 403 so
//     registration ids can't be enumerated).
//
// Send-side guards:
//   - A payment row with a checkout URL exists and isn't already paid.
//   - The registrant has a phone number on file (race_payments.contact_phone).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import { sendLocationSms, TwilioError, resolveTenantSmsSender } from '@/lib/twilio'
import { getAppUrl } from '@/lib/app-url'
import { overlayConnections } from '@/lib/connection-registry'
import { resolveEventCommsLocation, pickAudienceSignoffName } from '@/lib/event-comms-location'
import { checkTransactionalConsent } from '@/lib/transactional-consent'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

function currencySymbol(code) {
  if (code === 'EUR') return '€'
  if (code === 'GBP') return '£'
  if (code === 'USD') return '$'
  return code ? `${code} ` : ''
}

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()

  // Registration → race + its location (with the Twilio sender id).
  const { data: reg } = await db
    .from('race_registrations')
    .select(`
      id, status,
      race_events!inner (
        id, name, location_id, host_id, sending_location_id, venue_name,
        locations:location_id ( id, name, is_host_anchor, twilio_alpha_sender_id, organization_id )
      )
    `)
    .eq('id', params.id)
    .maybeSingle()
  // 404 (not 403) so registration ids can't be enumerated.
  if (!reg) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const locationId = reg.race_events.location_id
  const allowed = getUserLocationIds(user) // null = master (all locations)
  if (allowed !== null && !allowed.includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  // INTEG-A2 dual-read: registry twilio_sender row first.
  if (reg.race_events.locations) {
    reg.race_events.locations = await overlayConnections(db, reg.race_events.locations, ['twilio_sender'])
  }

  // Latest payment for this registration (newest first — same ordering
  // the teams list uses to attach the "current" payment).
  const { data: payment } = await db
    .from('race_payments')
    .select('id, status, contact_id, contact_name, contact_phone, amount_cents, currency')
    .eq('race_registration_id', params.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!payment) {
    return NextResponse.json({ success: false, error: 'No payment for this registrant yet.' }, { status: 400 })
  }
  if (payment.status === 'completed') {
    return NextResponse.json({ success: false, error: 'This registration is already paid.' }, { status: 400 })
  }
  if (!payment.contact_phone) {
    return NextResponse.json({ success: false, error: 'No phone number on file for this registrant — capture one before texting.' }, { status: 400 })
  }

  // EVENT-CONSENT.1 — the registrant may have told us not to text them.
  // Mirrors /api/contacts/[id]/sms (which 400s on a non-active sms_status) and
  // the sibling transactional senders, on the ADMINISTRATIVE family — a payment
  // link for a registration they started is transactional, not marketing.
  //
  // This one DOES fail closed, and that is a deliberate exception to the
  // usual "never let a guard cost a message" rule, because nothing here is
  // lost silently: the caller is a human operator looking at a button, they get
  // an actionable 400 naming the reason, and the same screen already carries a
  // "copy payment link" control they can use over any channel the registrant
  // has not opted out of. Texting someone who has explicitly opted out is the
  // one outcome that is both harmful and irreversible.
  //
  // An UNREADABLE consent row still SENDS (checkTransactionalConsent logs it) —
  // a database blip must not block an operator's explicit action.
  const smsGate = await checkTransactionalConsent({
    db, contactId: payment.contact_id, channel: 'sms',
    module: 'payment-sms', meta: { registrationId: params.id },
  })
  if (!smsGate.allowed) {
    return NextResponse.json({
      success: false,
      error: `Cannot text this registrant — ${smsGate.reason}. Copy the payment link and send it another way.`,
    }, { status: 400 })
  }

  // EVENT-COMMS-LOC — send the payment link from the event's comms location
  // (host events → the org master, not the sender-less anchor). resolveSenderLocation
  // is the inner safety net if that resolved location itself lacks a sender.
  // BAREWRITE.4 — resolveEventCommsLocation FAILS OPEN. It logs an unreadable
  // location row (structurally, via logError) and returns null; the
  // `|| reg.race_events.locations` fallback below is the event's own location,
  // which resolves to the same email identity (per-organisation, structural)
  // and — for every event prod holds today, though not for every location pair
  // in prod — the same Twilio alpha sender. See event-comms-location.js for the
  // measurement and for the condition that would end that. BAREWRITE.1 had it
  // throw and this route answer 503, refusing to send a payment link an
  // operator had explicitly asked for over a read that, today, only ever
  // chooses between two identical senders.
  let commsLocation = null
  try {
    commsLocation = await resolveEventCommsLocation(db, {
      location_id: reg.race_events.location_id,
      host_id: reg.race_events.host_id,
      sending_location_id: reg.race_events.sending_location_id,
    })
  } catch (e) {
    logError('payment-sms', 'comms location resolver threw; sending from the event location instead', {
      err: e, registrationId: params.id,
    })
    commsLocation = null
  }
  const eventLocation = reg.race_events.locations

  // EVENT-COPY.1 — THE SIGN-OFF THE CUSTOMER READS.
  //
  // This was `reg.race_events.locations?.name`, unconditionally. For a hosted
  // event that row is the ops-only anchor `ensureAnchorLocation` mints, named
  // "<host> (host events)" — so a registrant asked to pay got a text signed off
  // with an internal bookkeeping string. Two ACTIVE upcoming events sit on such
  // a row in prod today. The sibling confirmation path avoided it by preferring
  // `venue_name`; this route had no fallback at all, and `venue_name` alone is
  // not enough either (it is only mandatory for HOST-submitted events).
  //
  // pickAudienceSignoffName walks venue → resolved comms location → event
  // location, skipping anchors at every tier, and returns '' rather than an
  // internal label — which drops the sign-off entirely. The alpha sender still
  // carries the brand, so a signed-off-by-nobody text is fine; a text signed
  // "(host events)" is not.
  //
  // SIGN-OFF, not venue — and this is the ONE place the distinction runs the
  // other way. `— <name>` at the end of a text answers "who is texting you",
  // which is exactly what the comms location is, so it belongs in the tier list
  // here. The email "Where" row is a claim about geography and uses
  // pickAudienceVenueName, which excludes it. Read both headers before merging
  // them back into one helper.
  const locationName = pickAudienceSignoffName({
    venueName: reg.race_events.venue_name,
    commsLocation,
    eventLocation,
  })
  const firstName = (payment.contact_name || '').trim().split(/\s+/)[0] || 'there'
  const raceName = reg.race_events.name || 'your race'
  const amount = payment.amount_cents
    ? `${currencySymbol(payment.currency)}${(payment.amount_cents / 100).toFixed(2)} `
    : ''
  const signoff = locationName ? ` — ${locationName}` : ''
  const payLink = `${getAppUrl()}/event-pay/${payment.id}`
  const body = `Hi ${firstName}, here's your link to pay ${amount}and secure your spot for ${raceName}: ${payLink}${signoff}`

  // SENDER-REGISTRY.1 — refuse the cross-brand terminal rather than take it.
  // `resolveSenderLocation` used to hand back a senderless location and let
  // `getLocationSenderId` fall through to `TWILIO_FROM || 'CCFautos'` — CCF
  // Autos is a SEPARATE BUSINESS here, so an unconfigured gym would text a
  // payment link from a used-car dealership's sender. That is indistinguishable
  // from a scam and cannot be recalled.
  //
  // Failing closed is affordable *on this route specifically*: the operator is
  // present, gets a message naming the location to configure, and the "copy
  // payment link" button next to this one still works. Nothing is lost in
  // silence. (The unattended race-confirmation SMS leg makes the same call for
  // a different reason — there the email receipt carries the check-in QR.)
  //
  // 'unreadable' answers 503 with DIFFERENT copy, not 409. Telling an operator
  // to "set one in Location Settings" when the truth is a failed read sends
  // them to a screen where the sender is already correct, to change something
  // that was never wrong. Same refusal, honest reason.
  const { location: senderLocation, source: senderSource } =
    await resolveTenantSmsSender(db, commsLocation || eventLocation)
  if (senderSource === 'none' || senderSource === 'unreadable') {
    logError('payment-sms', senderSource === 'unreadable'
      ? 'tenant SMS sender lookup FAILED (not "unset") — refusing to send from the global cross-brand default'
      : 'no tenant SMS sender configured for this event — refusing to send from the global cross-brand default', {
      registrationId: params.id,
      senderLocationId: (commsLocation || eventLocation)?.id || null,
      senderSource,
    })
    if (senderSource === 'unreadable') {
      return NextResponse.json({
        success: false,
        error: 'Could not look up the SMS sender for this event just now — this is a temporary error, not a missing setting. Try again in a moment, or copy the payment link and send it another way.',
      }, { status: 503 })
    }
    return NextResponse.json({
      success: false,
      error: 'No SMS sender is configured for this event’s location or its organisation. Set one in Location Settings, or copy the payment link and send it another way.',
    }, { status: 409 })
  }

  let twilioResult
  try {
    twilioResult = await sendLocationSms({
      location: senderLocation,
      to: payment.contact_phone,
      body,
    })
  } catch (e) {
    if (e instanceof TwilioError) {
      return NextResponse.json(
        { success: false, error: `Twilio error: ${e.message}`, code: e.code },
        { status: 502 }
      )
    }
    return NextResponse.json(
      { success: false, error: e?.message || 'Failed to send SMS' },
      { status: 500 }
    )
  }

  // Best-effort activity log so the payment-reminder text shows on the
  // captain's contact timeline. Never blocks the response.
  if (payment.contact_id) {
    try {
      // Genuinely best-effort (the comment above) — but the error is READ, not
      // discarded: the try/catch alone catches nothing here, because a
      // supabase builder resolves with `{ data, error }` instead of throwing.
      const { error: timelineError } = await db.from('activities').insert({
        contact_id: payment.contact_id,
        location_id: locationId,
        type: 'sms_sent',
        subject: 'Payment reminder SMS',
        note: body,
        created_by: user.id,
      })
      if (timelineError) console.warn(`[payment-sms] activity log failed: ${timelineError.message}`)
    } catch (e) {
      console.warn(`[payment-sms] activity log failed: ${e?.message || e}`)
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      sid: twilioResult.sid,
      status: twilioResult.status,
      to: twilioResult.to,
    },
  })
}
