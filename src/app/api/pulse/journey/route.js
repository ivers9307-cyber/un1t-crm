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
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { loadJourneyLane } from '@/lib/onboarding-journey-data'
import { loadUn1tOnlineJourneyLane } from '@/lib/onboarding-journey-un1t'
import { membershipSourceState } from '@/lib/membership/source'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// pulse_admin somewhere ('Forbidden' 403), the studio (400 / 403), then
// pulse_admin there (403), in that order and with these texts, as before.
export const GET = withAuth(
  { permission: null, location: false, allow: (user) => hasPermissionAtAnyLocation(user, 'pulse_admin'), forbiddenMessage: 'Forbidden' },
  async ({ user, db, request }) => {
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
      logError('pulse-journey', 'journey lane read failed', { locationId, err: e })
      return NextResponse.json({ success: false, error: 'fetch_failed' }, { status: 500 })
    }
  },
)
