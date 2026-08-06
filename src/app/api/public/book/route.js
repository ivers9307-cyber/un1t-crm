import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody, uuidLike } from '@/lib/validate'
import { validateCustomResponses } from '@/lib/booking-validation'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const BookingSchema = z.object({
  event_type_id: uuidLike,
  booking_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM'),
  customer_name: z.string().min(1).max(200),
  customer_email: z.string().email().max(320),
  customer_phone: z.string().max(50).nullable().optional(),
  custom_responses: z.record(z.string(), z.unknown()).optional(),
  source: z.string().max(50).optional(),
  // CONSENT.4 — soft opt-in for marketing comms. Defaulted true
  // client-side; missing/undefined here is treated as true to
  // preserve back-compat for any older form deployments still in
  // a customer's browser cache.
  marketing_consent: z.boolean().optional(),
  // ADS-REPORT.2 — optional first-touch ad-click attribution captured by the
  // /start funnel from the landing URL's UTM/meta_ad_id params. Low-trust:
  // sanitised + length-capped before it ever reaches the DB (see below).
  attribution: z.object({
    utm_campaign: z.string().max(200).optional(),
    utm_content: z.string().max(200).optional(),
    utm_term: z.string().max(200).optional(),
    ad_provider: z.string().max(50).optional(),
    ad_external_id: z.string().max(200).optional(),
  }).optional(),
})

// POST /api/public/book — Public: create a booking
// No auth required — this is called from the public booking page
// The database trigger (handle_new_booking) automatically:
//   1. Creates or finds the contact
//   2. Creates a deal at "New Lead" stage
//   3. Fires the event's webhook URL (for n8n)
export async function POST(request) {
  const db = createServerClient()

  const ip = getClientIp(request)

  const validation = await validateBody(request, BookingSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Look up event to calculate end_time and validate custom_responses
  // against the event's declared custom_fields. Tier 2 of the Calendly
  // alignment — previously we accepted any shape because Zod only
  // validated the wrapper.
  // Mig 144 (GLOFOX3.2): also pull create_in_glofox + location_id so
  // we can fire the opt-in CRM → Glofox push after the booking lands.
  const { data: event } = await db.from('event_types')
    .select('name, duration_minutes, custom_fields, create_in_glofox, location_id')
    .eq('id', body.event_type_id)
    .single()

  if (!event) {
    return NextResponse.json({ success: false, error: 'Event type not found' }, { status: 404 })
  }

  // 5 booking attempts per IP per 15 minutes — generous enough that a real
  // user retrying after a typo or a lost slot won't hit it, tight enough
  // that scripted booking spam is throttled.
  // SAAS-6: tenant-keyed (the event's location) — one tenant's booking
  // traffic can never consume another tenant's window for the same IP.
  // Runs after the event lookup (a single indexed read, the same cost
  // class as the limiter RPC itself); malformed/unknown submissions
  // 400/404 above without consuming the window.
  const limit = await checkRateLimit(db, `book:${event.location_id}:${ip}`, { max: 5, windowMs: 15 * 60_000 })
  if (!limit.allowed) {
    return rateLimitResponse(limit, 'Too many booking attempts. Please wait a few minutes and try again.')
  }

  // Validate custom_responses against the event's custom_fields:
  //   - required fields must be non-empty
  //   - dropdown / radio fields: value must be in options[]
  //   - checkbox fields: must be boolean (or 'true'/'false' strings)
  // Unknown response keys (fields removed from the event since the
  // booking form was loaded) are tolerated rather than rejected so a
  // mid-flight schema change doesn't break the customer's booking.
  const customFieldsErr = validateCustomResponses(event.custom_fields, body.custom_responses)
  if (customFieldsErr) {
    return NextResponse.json({ success: false, error: customFieldsErr, field: 'custom_responses' }, { status: 400 })
  }

  // Calculate end time
  const [h, m] = body.start_time.split(':').map(Number)
  const endMinutes = h * 60 + m + event.duration_minutes
  const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`

  // Check slot is still available
  const { data: conflicts } = await db.from('bookings')
    .select('id')
    .eq('event_type_id', body.event_type_id)
    .eq('booking_date', body.booking_date)
    .in('status', ['confirmed', 'completed'])
    .lt('start_time', endTime)
    .gt('end_time', body.start_time)

  if (conflicts && conflicts.length > 0) {
    return NextResponse.json({ success: false, error: 'This time slot is no longer available' }, { status: 409 })
  }

  // Create booking — the DB trigger handles contact creation, deal creation, and webhook.
  // BOOKING.1 — copy event.location_id onto the booking. Without this
  // the booking was invisible in /bookings (location-scoped) and any
  // downstream code that reads booking.location_id directly (instead
  // of going through event_types) was getting nulls.
  const { data, error } = await db.from('bookings').insert({
    event_type_id: body.event_type_id,
    location_id: event.location_id || null,
    booking_date: body.booking_date,
    start_time: body.start_time,
    end_time: endTime,
    customer_name: body.customer_name,
    customer_email: body.customer_email.toLowerCase().trim(),
    customer_phone: body.customer_phone || null,
    custom_responses: body.custom_responses || {},
    source: body.source || 'booking_page',
  }).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // CONSENT.4 — soft opt-in for marketing. The handle_new_booking
  // trigger has already created/matched a contact for this email +
  // location, so look it up and apply the form's consent value.
  // ClassPass contacts are skipped server-side by the helper. Best-
  // effort: a consent-write hiccup never breaks the booking response.
  try {
    const consent = body.marketing_consent !== false  // default true
    const { data: c } = await db.from('contacts')
      .select('id')
      .eq('email', body.customer_email.toLowerCase().trim())
      .eq('location_id', event.location_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (c?.id) {
      const { applyFormMarketingConsent } = await import('@/lib/marketing-consent')
      await applyFormMarketingConsent(db, {
        contactId: c.id,
        consent,
        source:    'booking_form',
        ipAddress: ip,
        locationId: event.location_id,
      })
    }
  } catch (e) {
    logWarn('booking', `marketing consent write error`, { err: e })
  }

  // Fire booking_created + first_booking triggers for active
  // sequences. Best-effort — a sequence misconfig must never break
  // the booking response. The helpers themselves swallow + log
  // errors internally. first_booking checks prior bookings count
  // server-side and short-circuits when not the first.
  try {
    const { triggerSequencesForBooking, triggerSequencesForFirstBooking } = await import('@/lib/sequences')
    await triggerSequencesForBooking(data.id)
    await triggerSequencesForFirstBooking(data.id)
  } catch (e) {
    logWarn('booking', `sequence trigger error`, { err: e })
  }

  // Fire the per-event_type confirmation message (mig 077). Best-
  // effort: a Postmark or Twilio hiccup never breaks the customer's
  // success response; the on-page confirmation still shows. The
  // helper writes its own activity row + handles channel gates.
  let confirmation = null
  try {
    const { sendBookingConfirmation } = await import('@/lib/booking-confirmations')
    confirmation = await sendBookingConfirmation(db, data.id)
  } catch (e) {
    logWarn('booking', `confirmation send error`, { err: e })
  }

  // Attribute /start (source='meta_book') leads so the funnel is measurable,
  // mirroring /free-class: stamp lead_source + apply a campaign tag. Values are
  // hard-coded server-side (gated on source), so the client can't inject them.
  // Best-effort; never blocks the booking.
  try {
    if (body.source === 'meta_book' && data?.contact_id) {
      await db.from('contacts').update({ lead_source: 'meta_book' }).eq('id', data.contact_id).is('lead_source', null)
      const { writeContactTag } = await import('@/lib/contact-tags')
      await writeContactTag(db, { contactId: data.contact_id, locationId: data.location_id, tag: 'stillorgan-start' })
    }
  } catch (e) { logWarn('book', 'meta_book attribution failed', { err: e }) }

  // ADS-REPORT.2 — first-touch ad-click attribution (stamp-if-null). Marketing
  // params are low-trust: sanitised + length-capped. Only stamp when a real ad
  // signal is present so organic /start visitors never get ad_provider='meta'.
  try {
    if (data?.contact_id) {
      const a = body.attribution || {}
      const patch = {}
      for (const k of ['utm_campaign', 'utm_content', 'utm_term', 'ad_external_id']) {
        if (a[k] && String(a[k]).length <= 200) patch[k] = String(a[k])
      }
      if (Object.keys(patch).length) {
        if (a.ad_provider && String(a.ad_provider).length <= 50) patch.ad_provider = String(a.ad_provider)
        patch.attributed_at = new Date().toISOString()
        await db.from('contacts').update(patch).eq('id', data.contact_id).is('ad_external_id', null)
      }
    }
  } catch (e) { logWarn('attribution', 'utm persist failed', { err: e }) }

  // CAPI: /start consult bookings emit website Lead + Schedule (booking-keyed
  // event_ids so retries dedupe at Meta). meta_book only — this route serves
  // every public booking page. Dataset gating lives in the helper.
  try {
    if (body.source === 'meta_book') {
      const { sendWebsiteConversion } = await import('@/lib/meta-capi')
      const capi = {
        locationId: data.location_id,
        email: data.customer_email,
        phone: data.customer_phone,
        eventSourceUrl: 'https://www.un1tdublin.com/start',
        contentName: event.name || 'Consultation',
      }
      await sendWebsiteConversion(db, { ...capi, eventName: 'Lead', eventId: `bookinglead-${data.id}` })
      await sendWebsiteConversion(db, { ...capi, eventName: 'Schedule', eventId: `booking-${data.id}` })
    }
  } catch (e) { logWarn('book', 'capi events failed', { err: e }) }

  // Campaign WhatsApp confirmation (the /start funnel sends source='meta_book').
  // Best-effort; never blocks the booking response. UTILITY template; Dublin
  // day/time formatted the same way as the email/SMS confirmation.
  try {
    if (body.source === 'meta_book' && data?.contact_id) {
      const { fmtBookingTime } = await import('@/lib/booking-confirmations')
      const { maybeSendBookingWhatsappConfirm } = await import('@/lib/automations/booking-whatsapp-confirm')
      const { data: c } = await db.from('contacts')
        .select('id, first_name, name, phone, wa_phone').eq('id', data.contact_id).maybeSingle()
      if (c) {
        const firstName = c.first_name || (c.name ? c.name.split(' ')[0] : '') || 'there'
        const whenLabel = fmtBookingTime(data.booking_date, data.start_time)
        await maybeSendBookingWhatsappConfirm({
          db, locationId: data.location_id, contact: c,
          templateName: 'booking_consult_confirmed', bodyParams: [firstName, whenLabel],
        })
      }
    }
  } catch (e) { logWarn('book', 'whatsapp confirm failed', { err: e }) }

  // GLOFOX3.2 (mig 144). When the event_type is opted in, push the
  // booking customer to Glofox in create-and-trial mode. The
  // handle_new_booking trigger has already created (or matched) the
  // contact row by email + location_id, so we look it up and feed
  // it to the orchestrator. Best-effort, fire-and-forget — never
  // blocks the booking response. Failures land in
  // glofox_push_events for the operator's Review tab (mig 143).
  if (event.create_in_glofox && body.customer_email) {
    ;(async () => {
      try {
        const { findOrCreateGlofoxMember } = await import('@/lib/glofox-push')
        // Find the contact the trigger just upserted. Match on
        // email + location_id so we don't pick up a same-email
        // contact at a different studio.
        let contactQuery = db.from('contacts')
          .select('id, name, email, first_name, last_name, phone, dob, location_id, glofox_member_id')
          .eq('email', body.customer_email.toLowerCase().trim())
          .order('created_at', { ascending: false })
          .limit(1)
        if (event.location_id) contactQuery = contactQuery.eq('location_id', event.location_id)
        const { data: contact } = await contactQuery.maybeSingle()
        if (!contact) {
          logWarn('booking.glofox', `no contact found for ${body.customer_email} after booking ${data.id}`)
          return
        }
        // handle_new_booking only writes `name` (not split into
        // first/last). Glofox /2.0/register insists on both, so
        // we split out of name here as a fallback. The booking-
        // form input already has the customer's full name in one
        // field — splitting on whitespace covers the common case;
        // single-word names get a "—" last_name placeholder.
        let { first_name, last_name } = contact
        if ((!first_name || !last_name) && (contact.name || body.customer_name)) {
          const full = (contact.name || body.customer_name).trim().split(/\s+/)
          first_name = first_name || full[0] || ''
          last_name = last_name || (full.slice(1).join(' ') || '—')
        }
        await findOrCreateGlofoxMember({
          db,
          locationId: contact.location_id,
          contact: { ...contact, first_name, last_name },
          source: 'booking_form',
          createIfMissing: true,
          attachTrial: true,
        })
      } catch (e) {
        logWarn('booking.glofox', `push failed for ${body.customer_email}`, { err: e })
      }
    })()
  }

  return NextResponse.json({
    success: true,
    data,
    confirmation,
    message: 'Booking confirmed! You will receive a confirmation shortly.'
  })
}
