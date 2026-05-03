// POST /api/bookings/[id]/race-start
//
// Operator tapped Start at the start line. Stamps race_started_at to
// NOW() if the booking belongs to a timed event and hasn't already
// started. Auto-creates a team for the booking via ensureTeamForBooking
// if somehow there isn't one yet (rare — booking widget creates the
// team at signup; this is a back-stop).
//
// Permission: manager+ at the event's location. RLS reinforces.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { ensureTeamForBooking } from '@/lib/race-control'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ permission required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: booking, error: lookupErr } = await db
    .from('bookings')
    .select(`
      id, status, race_started_at, race_finished_at, team_id,
      contact_id, customer_name, customer_email,
      event_types ( id, location_id, is_timed_event )
    `)
    .eq('id', params.id)
    .single()
  if (lookupErr || !booking) {
    return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 })
  }
  const ev = booking.event_types
  if (!ev) {
    return NextResponse.json({ success: false, error: 'Booking has no event type' }, { status: 400 })
  }
  if (!ev.is_timed_event) {
    return NextResponse.json({ success: false, error: 'Event is not configured for race timing' }, { status: 400 })
  }

  const guard = assertLocationAccess(user, ev.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  if (booking.race_started_at) {
    return NextResponse.json({
      success: true,
      no_op: true,
      race_started_at: booking.race_started_at,
    })
  }

  // Ensure the team exists. Pass a synthesised "booking with location_id"
  // since bookings.location_id isn't a column — derived from event_type.
  let teamResult
  try {
    teamResult = await ensureTeamForBooking(db, {
      ...booking,
      location_id: ev.location_id,
    })
  } catch (e) {
    console.warn(`[race-start] ensureTeamForBooking failed for ${booking.id}: ${e.message}`)
    return NextResponse.json({ success: false, error: e.message || 'Team setup failed' }, { status: 500 })
  }

  const startedAt = new Date().toISOString()
  const { error: upErr } = await db
    .from('bookings')
    .update({ race_started_at: startedAt })
    .eq('id', booking.id)
  if (upErr) {
    return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    race_started_at: startedAt,
    team: teamResult.team,
    team_was_created: teamResult.created,
  })
}
