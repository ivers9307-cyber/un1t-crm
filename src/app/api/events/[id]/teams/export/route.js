// GET /api/events/[id]/teams/export
//
// Download the event's attendee list as a CSV — one row per team member, with
// the booking/team columns repeated (name, email, role, membership, booking
// phone). Same auth + data as the /api/events/[id]/teams manage view: session
// user with the `races` permission + location access. The fetch + CSV are
// shared with the host portal via @/lib/attendee-export. (EVENTS-EXPORT.1)

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { fetchEventAttendees, attendeeCsvResponse } from '@/lib/attendee-export'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select('id, location_id, name, slug, race_date')
    .eq('id', params.id)
    .single()
  if (raceErr || !race) return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, race.location_id)
  if (guard) return guard

  try {
    const regs = await fetchEventAttendees(db, params.id)
    return attendeeCsvResponse(race, regs)
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
