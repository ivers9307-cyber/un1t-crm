// POST /api/glofox/classes/cancel — cancel a Glofox class booking
// (UIX-P3b). The undo half of /api/glofox/classes/book — also the
// second leg of the live E2E test (book own member → verify → cancel).
//
// Body: { contact_id, booking_id } (booking_id = Glofox booking _id
// returned by the book route). Glofox cancellation rules ("no
// cancellation within X hours") come back in the response body and
// are surfaced verbatim.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import {
  cancelBooking,
  glofoxCredentialsForLocation,
  missingGlofoxCredentialsForLocation,
} from '@/lib/glofox'

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
  const missing = missingGlofoxCredentialsForLocation(creds)
  if (missing.length > 0) {
    return NextResponse.json({ success: false, error: 'Glofox is not configured for this studio.' }, { status: 400 })
  }

  const result = await cancelBooking(creds, body.booking_id, contact.glofox_member_id)
  if (!result.ok || result.body?.success === false) {
    const msg = result.body?.message || result.body?.message_code || `Glofox cancel failed (HTTP ${result.status})`
    return NextResponse.json({
      success: false,
      error: msg,
      glofox_status: result.status,
      glofox_body: result.body,
    }, { status: 502 })
  }

  return NextResponse.json({ success: true, glofox_body: result.body })
}
