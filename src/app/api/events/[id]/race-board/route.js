// GET /api/events/[id]/race-board?date=YYYY-MM-DD
//
// Returns the race-day bookings for one event on one date, with team
// + members joined. Used by the race-control UI which polls every 2s
// to keep multiple operators in sync.
//
// Manager+ permission at the event's location. RLS reinforces. All
// reads in one query — the polling cadence means we want this fast.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ permission required' }, { status: 403 })
  }

  const url = new URL(request.url)
  const date = url.searchParams.get('date')
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({
      success: false,
      error: 'Missing or invalid `date` query (YYYY-MM-DD).',
    }, { status: 400 })
  }

  const db = createServerClient()

  const { data: event, error: evErr } = await db
    .from('event_types')
    .select('id, name, location_id, is_timed_event, allowed_team_sizes, duration_minutes')
    .eq('id', params.id)
    .single()
  if (evErr || !event) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }
  if (!event.is_timed_event) {
    return NextResponse.json({
      success: false,
      error: 'Event is not configured for race timing.',
    }, { status: 400 })
  }

  const guard = assertLocationAccess(user, event.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  // Bookings for this event on this date. Pull every column the race
  // UI needs in one query — team + members joined via PostgREST embed.
  const { data: bookings, error: bookErr } = await db
    .from('bookings')
    .select(`
      id, status, booking_date, start_time, end_time,
      customer_name, customer_email, customer_phone,
      contact_id, team_id,
      race_started_at, race_finished_at,
      teams ( id, name, size, captain_contact_id,
        team_members ( id, name, email, role, contact_id )
      )
    `)
    .eq('event_type_id', params.id)
    .eq('booking_date', date)
    .order('start_time', { ascending: true })

  if (bookErr) {
    return NextResponse.json({ success: false, error: bookErr.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    event: {
      id: event.id,
      name: event.name,
      location_id: event.location_id,
      allowed_team_sizes: event.allowed_team_sizes,
      duration_minutes: event.duration_minutes,
    },
    date,
    bookings: bookings || [],
    // Server-side timestamp the client can use to rebase elapsed-time
    // calculations on (avoids client clock skew flickering the timer).
    server_now: new Date().toISOString(),
  })
}
