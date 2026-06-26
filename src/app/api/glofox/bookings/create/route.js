// /api/glofox/bookings/create — create a booking on a member's behalf.
//
// GLOFOX2.1.17 — Tier 2 #6. Foundation for "no-show recovery
// auto-rebook" sequence steps and "comeback offer free class"
// automations. Master-only for now (operator-with-permission gate
// can come later if/when this is wired into a CRM contact-page
// button).
//
// POST body:
//   {
//     "location_id":  "<uuid>",   -- optional, defaults to active location
//     "user_id":      "<glofox _id>",
//     "event_id":     "<glofox event _id>",
//     "guest_bookings": 0          -- optional extra guests
//   }
//
// Response: passes through Glofox's response (success + Booking
// OR success: false + message_code). Operator-facing endpoint
// returns 200 with body.ok=false on a Glofox-side rejection so the
// caller can surface the message_code.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { glofoxCredentialsForLocation, createBooking } from '@/lib/glofox'
import { validateBody } from '@/lib/validate'

const CreateBookingBody = z.object({
  location_id: uuidLike.optional(),
  user_id: z.string().min(1),
  event_id: z.string().min(1),
  namespace: z.string().optional(),
  guest_bookings: z.number().int().min(0).optional(),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  const validation = await validateBody(request, CreateBookingBody)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id || null
  if (!locationId) {
    return NextResponse.json({
      ok: false,
      error: 'Provide location_id in body or set an active location',
    }, { status: 400 })
  }

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    return NextResponse.json({
      ok: false,
      error: 'Glofox credentials not configured for this location.',
    }, { status: 400 })
  }

  const bookingRequest = {
    user_id: String(body.user_id),
    event_id: String(body.event_id),
    branch_id: creds.branchId,
    namespace: body.namespace || undefined,
    guest_bookings: Number.isFinite(body.guest_bookings) ? body.guest_bookings : 0,
  }

  const result = await createBooking(creds, bookingRequest)
  return NextResponse.json({
    ok: result.ok && result.body?.success !== false,
    glofox_status: result.status,
    response: result.body,
    hint: result.body?.message_code
      ? `Glofox rejected: ${result.body.message_code}`
      : result.ok
      ? 'Booking created successfully.'
      : 'Glofox returned an error — see response.',
  })
}
