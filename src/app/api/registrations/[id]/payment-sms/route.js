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
import { sendLocationSms, TwilioError, resolveSenderLocation } from '@/lib/twilio'
import { getAppUrl } from '@/lib/app-url'
import { overlayConnections } from '@/lib/connection-registry'
import { resolveEventCommsLocation } from '@/lib/event-comms-location'

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
        id, name, location_id, host_id, sending_location_id,
        locations:location_id ( id, name, twilio_alpha_sender_id, organization_id )
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

  // Build the reminder body. Alpha sender carries the brand, so the
  // copy stays short; append the location name as a sign-off (matches
  // the deposit-receipt SMS shape).
  const firstName = (payment.contact_name || '').trim().split(/\s+/)[0] || 'there'
  const raceName = reg.race_events.name || 'your race'
  const amount = payment.amount_cents
    ? `${currencySymbol(payment.currency)}${(payment.amount_cents / 100).toFixed(2)} `
    : ''
  const locationName = reg.race_events.locations?.name
  const signoff = locationName ? ` — ${locationName}` : ''
  const payLink = `${getAppUrl()}/event-pay/${payment.id}`
  const body = `Hi ${firstName}, here's your link to pay ${amount}and secure your spot for ${raceName}: ${payLink}${signoff}`

  // EVENT-COMMS-LOC — send the payment link from the event's comms location
  // (host events → the org master, not the sender-less anchor). resolveSenderLocation
  // is the inner safety net if that resolved location itself lacks a sender.
  // BAREWRITE.1 — resolveEventCommsLocation throws rather than silently
  // falling back to the sender-less anchor (wrong-brand sender) when it cannot
  // read the location rows. Refuse the send and say so; the operator retries.
  let commsLocation
  try {
    commsLocation = await resolveEventCommsLocation(db, {
      location_id: reg.race_events.location_id,
      host_id: reg.race_events.host_id,
      sending_location_id: reg.race_events.sending_location_id,
    })
  } catch (e) {
    return NextResponse.json({
      success: false,
      error: `Could not resolve which studio this text should send from, so nothing was sent (sending it anyway risks the wrong brand on the message). Try again: ${e.message}`,
    }, { status: 503 })
  }
  const senderLocation = await resolveSenderLocation(db, commsLocation || reg.race_events.locations)

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
