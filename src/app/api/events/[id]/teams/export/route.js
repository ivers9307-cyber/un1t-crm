// GET /api/events/[id]/teams/export
//
// Download the event's attendee list as a CSV — one row per team member, with
// the booking/team columns repeated (name, email, role, membership, booking
// phone). Same auth + data as the /api/events/[id]/teams manage view: session
// user with the `races` permission + location access. The fetch + CSV are
// shared with the host portal via @/lib/attendee-export. (EVENTS-EXPORT.1)

import { NextResponse } from 'next/server'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { logError } from '@/lib/log'
import { fetchEventAttendees, attendeeCsvResponse } from '@/lib/attendee-export'
import { resolveRegistrationQuestions } from '@/lib/registration-questions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in: `races` is judged anywhere first, then at
// the event's own studio, as before.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  if (!hasPermissionAtAnyLocation(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select('id, location_id, name, slug, race_date, registration_questions')
    .eq('id', params.id)
    .single()
  if (raceErr || !race) return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, race.location_id)
  if (guard) return guard
  // ROLESWEEP.1b — judged at the event's location, not the caller's active studio.
  if (!hasPermissionForLocation(user, race.location_id, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  try {
    const regs = await fetchEventAttendees(db, params.id)
    return attendeeCsvResponse(race, regs, { questions: resolveRegistrationQuestions(race) })
  } catch (err) {
    logError('events', 'attendee export failed', { raceId: params.id, err })
    return NextResponse.json({ success: false, error: 'Could not export the attendees.' }, { status: 500 })
  }
})
