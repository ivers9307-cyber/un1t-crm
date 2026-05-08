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
})

// POST /api/public/book — Public: create a booking
// No auth required — this is called from the public booking page
// The database trigger (handle_new_booking) automatically:
//   1. Creates or finds the contact
//   2. Creates a deal at "New Lead" stage
//   3. Fires the event's webhook URL (for n8n)
export async function POST(request) {
  const db = createServerClient()

  // 5 booking attempts per IP per 15 minutes — generous enough that a real
  // user retrying after a typo or a lost slot won't hit it, tight enough
  // that scripted booking spam is throttled.
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `book:${ip}`, { max: 5, windowMs: 15 * 60_000 })
  if (!limit.allowed) {
    return rateLimitResponse(limit, 'Too many booking attempts. Please wait a few minutes and try again.')
  }

  const validation = await validateBody(request, BookingSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Look up event to calculate end_time and validate custom_responses
  // against the event's declared custom_fields. Tier 2 of the Calendly
  // alignment — previously we accepted any shape because Zod only
  // validated the wrapper.
  const { data: event } = await db.from('event_types')
    .select('duration_minutes, custom_fields')
    .eq('id', body.event_type_id)
    .single()

  if (!event) {
    return NextResponse.json({ success: false, error: 'Event type not found' }, { status: 404 })
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

  // Create booking — the DB trigger handles contact creation, deal creation, and webhook
  const { data, error } = await db.from('bookings').insert({
    event_type_id: body.event_type_id,
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

  return NextResponse.json({
    success: true,
    data,
    confirmation,
    message: 'Booking confirmed! You will receive a confirmation shortly.'
  })
}
