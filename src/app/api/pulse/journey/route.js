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

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadJourneyLane } from '@/lib/onboarding-journey-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'pulse_admin')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const requested = new URL(request.url).searchParams.get('location_id')
  const locationId = requested || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  try {
    const data = await loadJourneyLane(db, locationId)
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'fetch_failed' }, { status: 500 })
  }
}
