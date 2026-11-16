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
import { readBookChatTemplate } from '@/lib/book-chat-copy'
import { createBooking, BOOKING_EVENT_COLUMNS } from '@/lib/bookings-write'
import { hasPermissionForLocation } from '@/lib/permissions'

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
    .select(BOOKING_EVENT_COLUMNS)
    .eq('id', body.event_type_id)
    .maybeSingle()
  if (!event || event.active === false) {
    return NextResponse.json({ success: false, error: 'Event type not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, event.location_id)
  if (guard) return guard
  // BOOKONE.1 — booking is gated on the bookings permission at the event's
  // studio (on by default for every role); the route used to check none.
  if (!hasPermissionForLocation(user, event.location_id, 'bookings')) {
    return NextResponse.json({ success: false, error: 'Bookings permission required' }, { status: 403 })
  }

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

  const customerName = contact.name
    || [contact.first_name, contact.last_name].filter(Boolean).join(' ')
    || contact.email

  // BOOKONE.1 — the shared create: the same slot rules the public page and
  // the customer reschedule apply (staff used to be able to book outside
  // hours, in the past or inside a blocked time), and the database refuses
  // an overlap that slips past the check.
  const created = await createBooking(db, {
    event,
    date: body.booking_date,
    startTime: body.start_time,
    customer: { name: customerName, email: contact.email, phone: contact.phone || null },
    source: 'staff_inbox',
  })
  if (!created.ok) {
    if (created.code === 'slot_check_failed') {
      logWarn('booking.staff', 'slot check failed', { err: created.error, eventTypeId: event.id })
      return NextResponse.json({ success: false, error: 'Could not check that time. Try again.' }, { status: 503 })
    }
    if (created.code === 'insert_failed') {
      return NextResponse.json({ success: false, error: created.error?.message || 'Could not create the booking.' }, { status: 400 })
    }
    return NextResponse.json({ success: false, error: 'This time slot is not available. Pick one of the offered times.' }, { status: 409 })
  }
  const data = created.booking

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

  // BOOKCHATCOPY.1 — the studio's editable chat confirmation for the Book
  // panel. The booking exists, so a failed read never fails this: logged, and
  // the panel sends the default words.
  const chat = await readBookChatTemplate(db, event.location_id)
  if (chat.error) {
    logWarn('booking.staff', 'chat confirmation template read failed; the default is used', { locationId: event.location_id, err: chat.error })
  }

  return NextResponse.json({ success: true, data, confirmation, chat_template: chat.template })
}
