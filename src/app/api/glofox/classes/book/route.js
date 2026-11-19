// POST /api/glofox/classes/book — book a CRM contact's linked Glofox
// member into a class (UIX-P3b, unified inbox Book tab).
//
// Body: { contact_id, event_id } (event_id = Glofox 24-hex event _id).
// The BookingRequest sent to Glofox is { user_id, model, model_id }
// per the 2026-06-11 dry-run probe (see GLOFOX_BOOKING_MODEL in
// src/lib/glofox.js). Glofox enforces capacity / double-booking /
// waitlist server-side; its message_code is surfaced verbatim on a
// failure; the result is judged by the shared booking layer
// (bookingOpsFor, BOOKLAYER.1) like every other booking path.

import { NextResponse } from 'next/server'
import { GLOFOX_SETTINGS_UNREADABLE, GLOFOX_SETTINGS_UNREADABLE_MESSAGE } from '@/lib/glofox-settings-read'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { readBookChatTemplate } from '@/lib/book-chat-copy'
import { logWarn } from '@/lib/log'
import {
  glofoxCredentialsForLocation,
  missingGlofoxCredentialsForLocation,
} from '@/lib/glofox'
import { bookingOpsFor } from '@/lib/booking-ops'
import { serverErrorResponse } from '@/lib/error-events'

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
  const { data: contact, error: contactErr } = await db.from('contacts')
    .select('id, name, first_name, location_id, glofox_member_id')
    .eq('id', body.contact_id)
    .maybeSingle()
  // GLOFOXWRITEJUDGE.1 — a failed read is not "no such contact".
  if (contactErr) {
    return serverErrorResponse({
      module: 'glofox-classes-book', error: contactErr, request, status: 500,
      publicMessage: 'Could not read the contact just now. Nothing was booked. Try again.',
    })
  }
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
  // REGISTRYREAD.1b: a failed settings read is not "not configured".
  if (creds.readError) {
    return NextResponse.json({ success: false, code: GLOFOX_SETTINGS_UNREADABLE, error: GLOFOX_SETTINGS_UNREADABLE_MESSAGE }, { status: 503 })
  }
  const missing = missingGlofoxCredentialsForLocation(creds)
  if (missing.length > 0) {
    return NextResponse.json({ success: false, error: 'Glofox is not configured for this studio.' }, { status: 400 })
  }

  // BOOKLAYER.1 — the shared booking layer: one judge for Glofox's
  // 200-with-a-failure-body and its success wrapper, the same as the /start
  // processor, Mia and the approval route. "Already booked" (Glofox's
  // member+event dedupe) is a success: the member IS in the class. The old
  // model self-discovery sweep went with it: GLOFOX_BOOKING_MODEL has booked
  // every class through the processor since, so the sweep never ran.
  const booking = await bookingOpsFor('glofox').book({ creds }, { glofoxMemberId: contact.glofox_member_id, eventId: body.event_id })
  const result = booking.raw || {}
  if (booking.verdict === 'done' && booking.alreadyBooked) {
    return NextResponse.json({
      success: true,
      already_booked: true,
      glofox_booking_id: booking.id,
      glofox_body: result.body,
    })
  }
  if (booking.verdict !== 'done') {
    // Surface Glofox's own words: exactly what the operator needs to see.
    const msg = result.body?.message || result.body?.message_code || `Glofox booking failed (HTTP ${result.status})`
    return NextResponse.json({
      success: false,
      error: msg,
      glofox_status: result.status,
      glofox_body: result.body,
    }, { status: 502 })
  }

  // BOOKCHATCOPY.1 — the studio's editable chat confirmation for the panel.
  // The member IS booked, so a failed read never fails this: logged, and the
  // panel sends the default words.
  const chat = await readBookChatTemplate(db, contact.location_id)
  if (chat.error) {
    logWarn('glofox-classes-book', 'chat confirmation template read failed; the default is used', { locationId: contact.location_id, err: chat.error })
  }

  return NextResponse.json({
    success: true,
    glofox_booking_id: booking.id,
    glofox_body: result.body,
    chat_template: chat.template,
    ...(result.recovered ? { recovered: result.recovered } : {}),
  })
}
