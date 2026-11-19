// POST /api/glofox/classes/cancel — cancel a Glofox class booking
// (UIX-P3b). The undo half of /api/glofox/classes/book — also the
// second leg of the live E2E test (book own member → verify → cancel).
//
// Body: { contact_id, booking_id } (booking_id = Glofox booking _id
// returned by the book route). Glofox cancellation rules ("no
// cancellation within X hours") come back in the response body and
// are surfaced verbatim.

import { NextResponse } from 'next/server'
import { GLOFOX_SETTINGS_UNREADABLE, GLOFOX_SETTINGS_UNREADABLE_MESSAGE } from '@/lib/glofox-settings-read'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation } from '@/lib/glofox'
import { bookingOpsFor } from '@/lib/booking-ops'

export const runtime = 'nodejs'

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Must be a 24-hex Glofox id')

const Schema = z.object({
  contact_id: uuidLike,
  booking_id: objectId,
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
  const { data: contact } = await db.from('contacts')
    .select('id, location_id, glofox_member_id')
    .eq('id', body.contact_id)
    .maybeSingle()
  if (!contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, contact.location_id)
  if (guard) return guard
  if (!contact.glofox_member_id) {
    return NextResponse.json({ success: false, error: 'Contact is not linked to a Glofox member.' }, { status: 400 })
  }

  const creds = await glofoxCredentialsForLocation(db, contact.location_id)
  // REGISTRYREAD.1b: a failed settings read is not "not configured".
  if (creds.readError) {
    return NextResponse.json({ success: false, code: GLOFOX_SETTINGS_UNREADABLE, error: GLOFOX_SETTINGS_UNREADABLE_MESSAGE }, { status: 503 })
  }
  const missing = missingGlofoxCredentialsForLocation(creds)
  if (missing.length > 0) {
    return NextResponse.json({ success: false, error: 'Glofox is not configured for this studio.' }, { status: 400 })
  }

  // BOOKINGOPS.1 — judged by the shared booking layer (a late-cancel rule
  // arrives as a 200 with success:false); the answer's wording is this route's.
  const result = await bookingOpsFor('glofox').cancel({ creds }, { glofoxMemberId: contact.glofox_member_id, bookingId: body.booking_id })
  if (result.verdict !== 'done') {
    return NextResponse.json({
      success: false,
      error: result.message,
      glofox_status: result.raw?.status,
      glofox_body: result.raw?.body,
    }, { status: 502 })
  }

  return NextResponse.json({ success: true, glofox_body: result.raw?.body })
}
