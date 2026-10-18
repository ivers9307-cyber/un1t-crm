// POST /api/un1t-online/classes/book — UN1TWRITE.14.
//
// Book a contact into a un1t.online class from the staff Book panel. Gated by
// gateUn1tStaffBooking (access at the BOOKING studio, writes on, the contact
// in its organisation with a un1t.online account there), then the `book`
// primitive with origin 'staff' and the member of staff as actor. Answers:
// done 200 (already booked is success); refused 409 with un1t.online's
// words; a spent budget 429; unclear 502 with the unknown copy.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { gateUn1tStaffBooking, staffWriteAnswer, UN1T_STAFF_COPY } from '@/lib/un1t-staff-booking'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'
import { book } from '@/lib/un1t-online-write-ops'

export const runtime = 'nodejs'
// A write plus its check read can wait out one budget window.
export const maxDuration = 120

const Schema = z.object({
  contact_id: uuidLike,
  location_id: uuidLike,
  event_id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Must be a un1t.online event id'),
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

  let r
  try {
    r = await book(db, {
      locationId: b.location_id, contactId: b.contact_id, un1tUserId: gate.un1tUserId, eventId: b.event_id,
      origin: 'staff', actor: { id: user.id },
    })
  } catch (err) {
    if (err instanceof Un1tSettingsReadError) return NextResponse.json({ success: false, error: UN1T_STAFF_COPY.settingsUnreadable }, { status: 503 })
    throw err
  }
  const { status, body } = staffWriteAnswer(r, { op: 'book' })
  return NextResponse.json(body, { status })
}
