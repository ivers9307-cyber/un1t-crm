// GET /api/live/[locationId]/roster
//
// UN1TBOOK.12 — who is booked into the class running now, for staff who hold
// `class_roster` but not `studio_management`. This is the roster half of
// GET /api/live/[locationId] and nothing else: no heart-rate sessions, no
// straps, no test mode, no door control. `has_bridge` lets the page say
// whether a bridge exists at the location at all.
//
// Auth: member of the location AND `class_roster` resolved AT that location
// (guardLiveLocation) — never the active one.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { guardLiveLocation } from '@/lib/live-access'
import { createServerClient } from '@/lib/supabase'
import { getClassRoster, mergeRosterWithSessions } from '@/lib/class-bookings'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const locationId = params.locationId
  const denied = guardLiveLocation(user, locationId, { permission: 'class_roster' })
  if (denied) return denied

  const db = createServerClient()
  const [rosterData, bridgeRead] = await Promise.all([
    getClassRoster(db, { locationId }),
    db.from('ble_bridges').select('id').eq('location_id', locationId).limit(1),
  ])

  // A failed bridge read is not worth failing the roster for; log it and say
  // "no bridge" (the page only uses this to explain an empty strap list).
  if (bridgeRead.error) {
    logError('live-roster', 'bridge read failed', { locationId, error: bridgeRead.error.message })
  }
  const hasBridge = !bridgeRead.error && (bridgeRead.data || []).length > 0

  // No sessions here: every entry is a booked member, labelled, with no HR.
  const roster = mergeRosterWithSessions(rosterData.roster, [])

  return NextResponse.json({
    ok: true,
    occurrence: rosterData.occurrence,
    roster,
    has_bridge: hasBridge,
  })
}
