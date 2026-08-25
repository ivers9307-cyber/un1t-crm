// POST /api/live/[locationId]/pair
//
// Override pairing for walk-ins / lent straps. Body:
//   { device_key, contact_id, bridge_id, booking_id? }
//
// device_key is protocol-aware — `ant:<deviceNumber>` or `ble:<MAC>`.
//
// Calls pairOverride which:
//   - finds or creates an open heart_rate_sessions for the contact
//   - inserts a strap_assignments row (the override layer)
//   - subsequent bridge samples for this device_key route to that session
//
// Auth (SEC-LIVE-API.1): master / owner / manager / head_coach at the
// location, who ALSO hold `studio_management` there (the permission the /live
// page requires). Lower roles can't pair.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { guardLiveLocation, LIVE_MUTATION_ROLES } from '@/lib/live-access'
import { createServerClient } from '@/lib/supabase'
import { pairOverride } from '@/lib/live-class'
import { canonicaliseDeviceKey } from '@/lib/bridge-samples'
import { logInfo } from '@/lib/log'
import { validateBody } from '@/lib/validate'

const PairSchema = z.object({
  device_key: z.string().optional(),
  contact_id: z.string().optional(),
  bridge_id: z.string().optional(),
  booking_id: z.string().nullable().optional(),
  // Default true: persist the pairing to contact_devices so it auto-attributes
  // future classes. Pass false for a genuine one-off lent strap.
  persist: z.boolean().optional(),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  const locationId = params.locationId
  const denied = guardLiveLocation(user, locationId, { roles: LIVE_MUTATION_ROLES })
  if (denied) return denied

  const validation = await validateBody(request, PairSchema, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const body = validation.data

  const deviceKey = canonicaliseDeviceKey(body?.device_key)
  const contactId = String(body?.contact_id || '').trim()
  const bridgeId = String(body?.bridge_id || '').trim()
  const bookingId = body?.booking_id ? String(body.booking_id).trim() : null

  if (!deviceKey || !contactId || !bridgeId) {
    return NextResponse.json({
      ok: false,
      error: 'device_key (ant:… or ble:…), contact_id and bridge_id are required',
    }, { status: 400 })
  }

  const persist = body?.persist !== false // default: persist the registration
  const db = createServerClient()
  const out = await pairOverride(db, { locationId, bridgeId, contactId, deviceKey, bookingId, persist, actorUserId: user.id })
  if (!out.ok) {
    return NextResponse.json({ ok: false, error: out.error }, { status: 400 })
  }
  logInfo('live-class', 'override pair', {
    locationId, contactId, deviceKey, bridgeId, sessionId: out.sessionId, actor: user.id,
    persistWarning: out.warning ?? null,
  })
  // `warning` = the pairing worked for this class but the permanent
  // registration was skipped (strap owned by another member, or the ownership
  // check failed). The coach should see it, not just the journal.
  return NextResponse.json(
    out.warning
      ? { ok: true, session_id: out.sessionId, warning: out.warning }
      : { ok: true, session_id: out.sessionId },
  )
}
