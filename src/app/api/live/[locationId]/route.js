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
import { withAuth } from '@/lib/with-auth'
import { guardLiveLocation } from '@/lib/live-access'
import { getLiveSessions, getAvailableStraps } from '@/lib/live-class'
import { getClassRoster, mergeRosterWithSessions } from '@/lib/class-bookings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in; guardLiveLocation judges the studio and
// studio_management AT the URL's studio, as before (its 403s unchanged).
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const locationId = params?.locationId
  const denied = guardLiveLocation(user, locationId)
  if (denied) return denied

  const [sessions, availableStraps, rosterData, { data: bridges }] = await Promise.all([
    getLiveSessions(db, locationId),
    getAvailableStraps(db, locationId),
    getClassRoster(db, { locationId }),
    db.from('ble_bridges').select('id, test_mode_until').eq('location_id', locationId),
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
    // UN1TBOOK.12 — at least one bridge row at the location; the page uses it
    // to tell "no straps yet" from "no bridge installed".
    has_bridge: (bridges || []).length > 0,
    test_mode_until: testModeUntilMs ? new Date(testModeUntilMs).toISOString() : null,
  })
})
