// POST /api/bookings/create — staff-side booking create (UIX-P3a).
//
// The unified inbox's Book tab books a consultation for the thread's
// linked contact without leaving the page. Mirrors /api/public/book
// (same end-time calc, same overlap check, same best-effort side
// effects) but: session-authed + location-gated, takes a contact_id
// instead of free-typed customer fields, no rate limit (operator
// action), and deliberately NO Glofox trial push — the public form's
// create-and-trial flow is for new leads, not existing contacts.
//
// The handle_new_booking trigger links contact_id by customer_email
// match (unconditionally), so the contact's email is required and is
// what ties the booking back to the right person.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const Schema = z.object({
  event_type_id: uuidLike,
  contact_id: uuidLike,
  booking_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM'),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: event } = await db.from('event_types')
    .select('id, name, duration_minutes, location_id, active')
    .eq('id', body.event_type_id)
    .maybeSingle()
  if (!event || event.active === false) {
    return NextResponse.json({ success: false, error: 'Event type not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, event.location_id)
  if (guard) return guard

  const { data: contact } = await db.from('contacts')
    .select('id, name, first_name, last_name, email, phone, location_id')
    .eq('id', body.contact_id)
    .maybeSingle()
  if (!contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }
  if (contact.location_id !== event.location_id) {
    return NextResponse.json({ success: false, error: 'Contact and event belong to different studios' }, { status: 400 })
  }
  if (!contact.email) {
    return NextResponse.json({
      success: false,
      error: 'This contact has no email address — add one on their profile first (bookings require it).',
    }, { status: 400 })
  }

  // End time + still-available check — same shape as /api/public/book.
  const [h, m] = body.start_time.split(':').map(Number)
  const endMinutes = h * 60 + m + event.duration_minutes
  const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`

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

  const customerName = contact.name
    || [contact.first_name, contact.last_name].filter(Boolean).join(' ')
    || contact.email

  const { data, error } = await db.from('bookings').insert({
    event_type_id: body.event_type_id,
    location_id: event.location_id || null,   // BOOKING.1 — propagate
    booking_date: body.booking_date,
    start_time: body.start_time,
    end_time: endTime,
    customer_name: customerName,
    customer_email: contact.email.toLowerCase().trim(),
    customer_phone: contact.phone || null,
    custom_responses: {},
    source: 'staff_inbox',
  }).select().single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Best-effort side effects — identical to the public flow.
  try {
    const { triggerSequencesForBooking, triggerSequencesForFirstBooking } = await import('@/lib/sequences')
    await triggerSequencesForBooking(data.id)
    await triggerSequencesForFirstBooking(data.id)
  } catch (e) {
    logWarn('booking.staff', 'sequence trigger error', { err: e })
  }

  let confirmation = null
  try {
    const { sendBookingConfirmation } = await import('@/lib/booking-confirmations')
    confirmation = await sendBookingConfirmation(db, data.id)
  } catch (e) {
    logWarn('booking.staff', 'confirmation send error', { err: e })
  }

  return NextResponse.json({ success: true, data, confirmation })
}
