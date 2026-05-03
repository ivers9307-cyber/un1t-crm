// POST /api/bookings/[id]/race-reset
//
// Operator mistake undo. Clears both race_started_at and
// race_finished_at back to NULL. Useful when the wrong team got
// tapped at the start or finish line. Manager+ at the event's location.
//
// Doesn't touch the team_id link — the team still exists, just no
// race timing recorded for this booking. Lets the operator immediately
// re-tap Start without losing team identity.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

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
      id,
      event_types ( id, location_id, is_timed_event )
    `)
    .eq('id', params.id)
    .single()
  if (lookupErr || !booking) {
    return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 })
  }
  if (!booking.event_types?.is_timed_event) {
    return NextResponse.json({ success: false, error: 'Event is not configured for race timing' }, { status: 400 })
  }

  const guard = assertLocationAccess(user, booking.event_types.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const { error: upErr } = await db
    .from('bookings')
    .update({ race_started_at: null, race_finished_at: null })
    .eq('id', booking.id)
  if (upErr) {
    return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
