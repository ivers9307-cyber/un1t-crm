// GET /api/races/[id]/control-board
//
// Race-day polling endpoint. Returns the race + every registration
// with team + members joined. Used by /races/[id]/control which
// polls every 2s to keep multiple operators in sync (start line +
// finish line + back office).
//
// Manager+ at the race's location.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select(`
      id, name, location_id, race_date, allowed_team_sizes,
      waves:race_waves ( id, start_time, capacity, label, display_order )
    `)
    .eq('id', params.id)
    .single()
  if (raceErr || !race) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, race.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const { data: registrations, error: regErr } = await db
    .from('race_registrations')
    .select(`
      id, status, race_started_at, race_finished_at, registered_at, wave_id,
      team_composition,
      teams ( id, name, size, captain_contact_id,
        team_members ( id, name, email, role, is_member, member_validation_status )
      )
    `)
    .eq('race_event_id', params.id)
    .order('registered_at', { ascending: true })

  if (regErr) {
    return NextResponse.json({ success: false, error: regErr.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    race,
    registrations: registrations || [],
    server_now: new Date().toISOString(),
  })
}
