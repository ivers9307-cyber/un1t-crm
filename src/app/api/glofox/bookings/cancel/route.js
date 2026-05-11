// /api/glofox/bookings/cancel — cancel a booking on a member's behalf.
//
// GLOFOX2.1.17 — Tier 2 #6. Master-only. Glofox enforces the
// studio's cancellation rules server-side (e.g. "no cancellation
// within 2h of class") and returns the rule violation in the
// response body — we pass that through.
//
// POST body:
//   {
//     "location_id":  "<uuid>",   -- optional, defaults to active location
//     "booking_id":   "<glofox booking _id>",
//     "user_id":      "<glofox member _id>"
//   }

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { glofoxCredentialsForLocation, cancelBooking } from '@/lib/glofox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  let body
  try { body = await request.json() } catch { body = {} }
  const locationId = body.location_id || user.activeLocation?.id || null
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({
      ok: false,
      error: 'Provide location_id in body or set an active location',
    }, { status: 400 })
  }
  if (!body.booking_id || !body.user_id) {
    return NextResponse.json({
      ok: false,
      error: 'booking_id and user_id are required',
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

  const result = await cancelBooking(creds, body.booking_id, body.user_id)
  return NextResponse.json({
    ok: result.ok && result.body?.success !== false,
    glofox_status: result.status,
    response: result.body,
    hint: result.ok
      ? 'Booking cancelled successfully.'
      : `Glofox refused: ${result.body?.message || result.body?.message_code || 'unknown'}`,
  })
}
