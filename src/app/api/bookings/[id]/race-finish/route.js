// POST /api/bookings/[id]/race-finish
//
// Operator tapped Finish at the finish line. Stamps race_finished_at
// to NOW() if the booking is started but not yet finished. Same
// permission gate as race-start.

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
      id, race_started_at, race_finished_at,
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

  if (!booking.race_started_at) {
    return NextResponse.json({
      success: false,
      error: 'Cannot finish a race that has not started.',
      code: 'not_started',
    }, { status: 409 })
  }
  if (booking.race_finished_at) {
    return NextResponse.json({
      success: true,
      no_op: true,
      race_finished_at: booking.race_finished_at,
    })
  }

  const finishedAt = new Date().toISOString()
  const { error: upErr } = await db
    .from('bookings')
    .update({ race_finished_at: finishedAt })
    .eq('id', booking.id)
  if (upErr) {
    return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    race_started_at: booking.race_started_at,
    race_finished_at: finishedAt,
  })
}
