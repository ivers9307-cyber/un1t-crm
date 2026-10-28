// POST /api/un1t-online/classes/move — UN1TMOVE.1.
//
// Move a contact's un1t.online booking to another class from the staff Book
// panel, in ONE un1t.online call (POST /bookings/{id}/move), instead of a
// cancel then a book, which leaves a window where the credit or the spot is
// lost. Same gate as book and cancel (access at the BOOKING studio, writes on,
// the contact in its organisation with an account there); the booking must be
// THIS contact's at THIS studio in the mirror (404 otherwise), and the target
// a scheduled future class on this studio's timetable (409 otherwise). Then
// the `moveBooking` primitive with origin 'staff', the actor, and the
// booking's own class as the original. Same answers as book and cancel.
// UN1TMOVE.2 — the late-window rule lives in moveBooking (inside the window,
// a class the same studio day only), and a done move hands the panel the
// studio's editable "your booking was moved" text (chat_template), which the
// panel drops into an open WhatsApp thread exactly as a booking's is.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { gateUn1tStaffBooking, staffWriteAnswer, UN1T_STAFF_COPY } from '@/lib/un1t-staff-booking'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'
import { moveBooking } from '@/lib/un1t-online-write-ops'
import { readMoveChatTemplate } from '@/lib/book-chat-copy'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
// A write plus its check read can wait out one budget window.
export const maxDuration = 120

const un1tId = (what) => z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, `Must be a un1t.online ${what} id`)
const Schema = z.object({
  contact_id: uuidLike,
  location_id: uuidLike,
  booking_id: un1tId('booking'),
  event_id: un1tId('event'),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const b = validation.data

  const db = createServerClient()
  const gate = await gateUn1tStaffBooking(db, user, { locationId: b.location_id, contactId: b.contact_id })
  if (!gate.ok) return NextResponse.json({ success: false, error: gate.error }, { status: gate.status })

  const { data: booking, error } = await db
    .from('un1t_bookings')
    .select('un1t_id, event_id')
    .eq('location_id', b.location_id)
    .eq('un1t_id', b.booking_id)
    .eq('un1t_user_id', gate.un1tUserId)
    .limit(1)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: 'Could not read the booking just now. Try again.' }, { status: 503 })
  if (!booking) return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 })

  // The target must be on THIS studio's timetable, scheduled and still ahead.
  const { data: target, error: evError } = await db
    .from('un1t_events')
    .select('un1t_id')
    .eq('location_id', b.location_id)
    .eq('un1t_id', b.event_id)
    .eq('status', 'scheduled')
    .gt('starts_at', new Date().toISOString())
    .limit(1)
    .maybeSingle()
  if (evError) return NextResponse.json({ success: false, error: 'Could not read the timetable just now. Try again.' }, { status: 503 })
  if (!target) return NextResponse.json({ success: false, error: UN1T_STAFF_COPY.moveTargetUnavailable }, { status: 409 })

  let r
  try {
    r = await moveBooking(db, {
      locationId: b.location_id, contactId: b.contact_id, un1tUserId: gate.un1tUserId,
      bookingId: b.booking_id, eventId: b.event_id, fromEventId: booking.event_id ?? null,
      origin: 'staff', actor: { id: user.id },
    })
  } catch (err) {
    if (err instanceof Un1tSettingsReadError) return NextResponse.json({ success: false, error: UN1T_STAFF_COPY.settingsUnreadable }, { status: 503 })
    throw err
  }
  const { status, body } = staffWriteAnswer(r, { op: 'move' })
  if (status === 200) {
    // The booking IS moved, so a failed read never fails this: the panel sends the default.
    const chat = await readMoveChatTemplate(db, b.location_id)
    if (chat.error) logWarn('un1t-classes-move', 'move confirmation template read failed; the default is used', { locationId: b.location_id, err: chat.error })
    body.data.chat_template = chat.template ?? null
  }
  return NextResponse.json(body, { status })
}
