// POST /api/un1t-online/classes/cancel — UN1TWRITE.14.
//
// Cancel a contact's un1t.online booking from the staff Book panel. Same gate
// as the book route; the booking must be THIS contact's at THIS studio in the
// mirror (un1t_bookings), else 404. Then the `cancel` primitive (an empty
// body, never a refund flag) with origin 'staff' and the actor.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { gateUn1tStaffBooking, staffWriteAnswer, UN1T_STAFF_COPY } from '@/lib/un1t-staff-booking'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'
import { cancel } from '@/lib/un1t-online-write-ops'

export const runtime = 'nodejs'
export const maxDuration = 120

const Schema = z.object({
  contact_id: uuidLike,
  location_id: uuidLike,
  booking_id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Must be a un1t.online booking id'),
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
    .select('un1t_id')
    .eq('location_id', b.location_id)
    .eq('un1t_id', b.booking_id)
    .eq('un1t_user_id', gate.un1tUserId)
    .limit(1)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: 'Could not read the booking just now. Try again.' }, { status: 503 })
  if (!booking) return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 })

  let r
  try {
    r = await cancel(db, {
      locationId: b.location_id, contactId: b.contact_id, un1tUserId: gate.un1tUserId, bookingId: b.booking_id,
      origin: 'staff', actor: { id: user.id },
    })
  } catch (err) {
    if (err instanceof Un1tSettingsReadError) return NextResponse.json({ success: false, error: UN1T_STAFF_COPY.settingsUnreadable }, { status: 503 })
    throw err
  }
  const { status, body } = staffWriteAnswer(r, { op: 'cancel' })
  return NextResponse.json(body, { status })
}
