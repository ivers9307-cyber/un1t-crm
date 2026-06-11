// POST /api/glofox/classes/book — book a CRM contact's linked Glofox
// member into a class (UIX-P3b, unified inbox Book tab).
//
// Body: { contact_id, event_id } (event_id = Glofox 24-hex event _id).
// The BookingRequest sent to Glofox is { user_id, model, model_id }
// per the 2026-06-11 dry-run probe (see GLOFOX_BOOKING_MODEL in
// src/lib/glofox.js). Glofox enforces capacity / double-booking /
// waitlist server-side; its message_code is surfaced VERBATIM so the
// operator sees exactly what Glofox said (design-doc requirement).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import {
  createBooking,
  GLOFOX_BOOKING_MODEL,
  glofoxCredentialsForLocation,
  missingGlofoxCredentialsForLocation,
} from '@/lib/glofox'

export const runtime = 'nodejs'

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Must be a 24-hex Glofox id')

const Schema = z.object({
  contact_id: uuidLike,
  event_id: objectId,
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
    .select('id, name, first_name, location_id, glofox_member_id')
    .eq('id', body.contact_id)
    .maybeSingle()
  if (!contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, contact.location_id)
  if (guard) return guard
  if (!contact.glofox_member_id) {
    return NextResponse.json({
      success: false,
      error: 'This contact is not linked to a Glofox member — classes can only be booked for synced members.',
    }, { status: 400 })
  }

  const creds = await glofoxCredentialsForLocation(db, contact.location_id)
  const missing = missingGlofoxCredentialsForLocation(creds)
  if (missing.length > 0) {
    return NextResponse.json({ success: false, error: 'Glofox is not configured for this studio.' }, { status: 400 })
  }

  const result = await createBooking(creds, {
    user_id: contact.glofox_member_id,
    model: GLOFOX_BOOKING_MODEL,
    model_id: body.event_id,
  })

  if (!result.ok || result.body?.success === false) {
    // Surface Glofox's own words — message_code values like
    // YOU_HAVE_BOOKED_FOR_THIS_EVENT are exactly what the operator
    // needs to see.
    const msg = result.body?.message || result.body?.message_code || `Glofox booking failed (HTTP ${result.status})`
    return NextResponse.json({
      success: false,
      error: msg,
      glofox_status: result.status,
      glofox_body: result.body,
    }, { status: 502 })
  }

  return NextResponse.json({
    success: true,
    glofox_booking_id: result.body?._id || result.body?.data?._id || null,
    glofox_body: result.body,
  })
}
