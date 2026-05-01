import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody, uuidLike } from '@/lib/validate'

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

  // Look up event to calculate end_time
  const { data: event } = await db.from('event_types')
    .select('duration_minutes')
    .eq('id', body.event_type_id)
    .single()

  if (!event) {
    return NextResponse.json({ success: false, error: 'Event type not found' }, { status: 404 })
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

  // Fire booking_created triggers for active sequences. Best-effort —
  // a sequence misconfig must never break the booking response. The
  // helper itself swallows + logs errors internally.
  try {
    const { triggerSequencesForBooking } = await import('@/lib/sequences')
    await triggerSequencesForBooking(data.id)
  } catch (e) {
    console.warn(`[booking] sequence trigger error: ${e?.message || e}`)
  }

  return NextResponse.json({
    success: true,
    data,
    message: 'Booking confirmed! You will receive a confirmation shortly.'
  })
}
