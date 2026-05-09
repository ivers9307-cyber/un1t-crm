// POST /api/registrations/[id]/race-start
//
// Race-day operator tap. Stamps race_started_at = NOW() if not
// already started. Manager+ at the race's location.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: reg, error: lookupErr } = await db
    .from('race_registrations')
    .select(`
      id, status, race_started_at, race_finished_at,
      race_events ( id, location_id, kind )
    `)
    .eq('id', params.id)
    .single()
  if (lookupErr || !reg) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, reg.race_events?.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  // Mig 122 (E7): race-day timing only applies to kind='race'.
  // A workshop/seminar/etc. registration has no "started" semantics
  // — return 409 to make the operator UI failure mode obvious if
  // it ever fires (the control panel page is also gated, so this is
  // belt-and-braces).
  if (reg.race_events?.kind && reg.race_events.kind !== 'race') {
    return NextResponse.json({
      success: false,
      error: `Race-day timing doesn't apply to ${reg.race_events.kind} events.`,
    }, { status: 409 })
  }

  if (reg.status !== 'confirmed') {
    return NextResponse.json({
      success: false,
      error: `Cannot start race for a ${reg.status} registration.`,
    }, { status: 409 })
  }
  if (reg.race_started_at) {
    return NextResponse.json({
      success: true,
      no_op: true,
      race_started_at: reg.race_started_at,
    })
  }

  const startedAt = new Date().toISOString()
  const { error: upErr } = await db
    .from('race_registrations')
    .update({ race_started_at: startedAt })
    .eq('id', reg.id)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })

  return NextResponse.json({ success: true, race_started_at: startedAt })
}
