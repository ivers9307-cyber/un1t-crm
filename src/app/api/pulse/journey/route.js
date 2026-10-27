// GET /api/pulse/journey
//
// PULSE-90.2 — the first-90-days journey lane for the /pulse operator hub:
// every new member at the location scored against the 9-classes-in-6-weeks
// pace (compute-on-read via loadJourneyLane), worst-first, each with their
// latest coach touch.
//
// Query: location_id (optional, uuid) — defaults to the caller's active
// location; a supplied id is IDOR-guarded by assertLocationAccess.
//
// Access: pulse_admin permission (owner/manager/head_coach by default —
// added to shared/permissions.js in PULSE-90.4).
//
// PULSEUN1T.1 — the lane follows the studio's membership source: a
// un1t.online studio (Hatch Street) reads its members and classes from the
// un1t.online mirror (loadUn1tOnlineJourneyLane, display only); every other
// studio keeps the Glofox lane. An unreadable source is a 500, never a guess.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadJourneyLane } from '@/lib/onboarding-journey-data'
import { loadUn1tOnlineJourneyLane } from '@/lib/onboarding-journey-un1t'
import { membershipSourceState } from '@/lib/membership/source'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermissionAtAnyLocation(user, 'pulse_admin')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const requested = new URL(request.url).searchParams.get('location_id')
  const locationId = requested || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  // ROLESWEEP.1a — the permission is judged at the lane's location.
  if (!hasPermissionForLocation(user, locationId, 'pulse_admin')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  try {
    const source = await membershipSourceState(db, locationId)
    if (!source.source) {
      return NextResponse.json({ success: false, error: 'Could not read this studio\'s membership source' }, { status: 500 })
    }
    const data = source.source === 'un1t_online'
      ? await loadUn1tOnlineJourneyLane(db, locationId)
      : await loadJourneyLane(db, locationId)
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'fetch_failed' }, { status: 500 })
  }
}
