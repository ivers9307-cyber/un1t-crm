// POST /api/live/[locationId]/pair
//
// Override pairing for walk-ins / lent straps. Body:
//   { strap_mac, contact_id, bridge_id, booking_id? }
//
// Calls pairOverride which:
//   - finds or creates an open heart_rate_sessions for the contact
//   - inserts a strap_assignments row (the override layer)
//   - subsequent bridge samples for this MAC route to that session
//
// Auth: master / owner / manager / head_coach / coach at the
// location. Lower roles can't pair.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { pairOverride } from '@/lib/live-class'
import { logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['owner', 'manager', 'head_coach', 'coach']

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  const locationId = params.locationId
  if (!user.isMaster && !ALLOWED_ROLES.includes(user.role)) {
    return NextResponse.json({ ok: false, error: 'Coach only' }, { status: 403 })
  }
  if (!user.isMaster && !(user.locationIds || []).includes(locationId)) {
    return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
  }

  let body
  try { body = await request.json() } catch { body = {} }

  const strapMac = String(body?.strap_mac || '').trim()
  const contactId = String(body?.contact_id || '').trim()
  const bridgeId = String(body?.bridge_id || '').trim()
  const bookingId = body?.booking_id ? String(body.booking_id).trim() : null

  if (!strapMac || !contactId || !bridgeId) {
    return NextResponse.json({
      ok: false,
      error: 'strap_mac, contact_id and bridge_id are required',
    }, { status: 400 })
  }

  const db = createServerClient()
  const out = await pairOverride(db, { locationId, bridgeId, contactId, strapMac, bookingId })
  if (!out.ok) {
    return NextResponse.json({ ok: false, error: out.error }, { status: 400 })
  }
  logInfo('live-class', 'override pair', {
    locationId, contactId, strapMac, bridgeId, sessionId: out.sessionId, actor: user.id,
  })
  return NextResponse.json({ ok: true, session_id: out.sessionId })
}
