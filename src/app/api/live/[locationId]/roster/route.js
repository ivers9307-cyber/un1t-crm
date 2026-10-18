// GET /api/live/[locationId]/roster
//
// UN1TBOOK.12 — who is booked into the class running now, for staff who hold
// `class_roster` but not `studio_management`. This is the roster half of
// GET /api/live/[locationId] and nothing else: no heart-rate sessions, no
// straps, no test mode, no door control. Each entry is `{ label, booked }` and
// nothing else: the HR fields mergeRosterWithSessions carries (hasHr, anon,
// currentBpm, sessionId) are dropped here, at the data layer, so the response
// cannot carry strap state whatever the page renders.
//
// Auth: member of the location AND `class_roster` resolved AT that location
// (guardLiveLocation) — never the active one.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { guardLiveLocation } from '@/lib/live-access'
import { createServerClient } from '@/lib/supabase'
import { getClassRoster, mergeRosterWithSessions } from '@/lib/class-bookings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const locationId = params.locationId
  const denied = guardLiveLocation(user, locationId, { permission: 'class_roster' })
  if (denied) return denied

  const db = createServerClient()
  const rosterData = await getClassRoster(db, { locationId })

  // No sessions are read here; mergeRosterWithSessions only drops CANCELLED
  // and labels each booked member. Keep the label and the booked flag, drop
  // the HR fields it adds.
  const roster = mergeRosterWithSessions(rosterData.roster, []).map(({ label, booked }) => ({ label, booked }))

  return NextResponse.json({
    ok: true,
    occurrence: rosterData.occurrence,
    roster,
  })
}
