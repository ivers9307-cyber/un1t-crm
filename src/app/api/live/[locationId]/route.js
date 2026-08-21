// GET /api/live/[locationId]
//
// Returns the current state of all open HR sessions at the location
// + the list of available straps the bridge is broadcasting that
// aren't yet routed. The coach view polls this every ~2s.
//
// Auth (SEC-LIVE-API.1): a member of the location who holds
// `studio_management` there — the same permission /live/[locationId]
// requires. Anyone else gets 401/403; see src/lib/live-access.js for why the
// studio TVs are unaffected.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { guardLiveLocation } from '@/lib/live-access'
import { createServerClient } from '@/lib/supabase'
import { getLiveSessions, getAvailableStraps } from '@/lib/live-class'
import { getClassRoster, mergeRosterWithSessions } from '@/lib/class-bookings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  const locationId = params.locationId
  const denied = guardLiveLocation(user, locationId)
  if (denied) return denied

  const db = createServerClient()
  const [sessions, availableStraps, rosterData, { data: bridges }] = await Promise.all([
    getLiveSessions(db, locationId),
    getAvailableStraps(db, locationId),
    getClassRoster(db, { locationId }),
    db.from('ble_bridges').select('test_mode_until').eq('location_id', locationId),
  ])

  // HR-CLASS-ALLOC.2 — the live-class roster panel: everyone booked into the
  // class running now, with HR overlaid on whoever's wearing a strap, plus anon
  // walk-ins. Empty array when no class is live.
  const roster = mergeRosterWithSessions(rosterData.roster, sessions)

  const testModeUntilMs = (bridges || [])
    .map((b) => b.test_mode_until).filter(Boolean)
    .map((t) => new Date(t).getTime()).filter((t) => t > Date.now())
    .sort((a, b) => b - a)[0]

  return NextResponse.json({
    ok: true,
    server_time: new Date().toISOString(),
    sessions,
    available_straps: availableStraps,
    roster,
    occurrence: rosterData.occurrence,
    test_mode_until: testModeUntilMs ? new Date(testModeUntilMs).toISOString() : null,
  })
}
