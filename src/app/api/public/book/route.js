import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// POST /api/public/book — Public: create a booking
// No auth required — this is called from the public booking page
// The database trigger (handle_new_booking) automatically:
//   1. Creates or finds the contact
//   2. Creates a deal at "New Lead" stage
//   3. Fires the event's webhook URL (for n8n)
export async function POST(request) {
  const body = await request.json()
  const db = createServerClient()

  // Validate required fields
  if (!body.event_type_id || !body.booking_date || !body.start_time || !body.customer_name || !body.customer_email) {
    return NextResponse.json({
      success: false,
      error: 'Missing required fields: event_type_id, booking_date, start_time, customer_name, customer_email'
    }, { status: 400 })
  }

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

  return NextResponse.json({
    success: true,
    data,
    message: 'Booking confirmed! You will receive a confirmation shortly.'
  })
}
