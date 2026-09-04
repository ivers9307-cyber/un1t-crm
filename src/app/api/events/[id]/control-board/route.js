// GET /api/events/[id]/control-board
//
// Race-day polling endpoint. Returns the race + every registration
// with team + members joined. Used by /events/[id]/control which
// polls every 2s to keep multiple operators in sync (start line +
// finish line + back office).
//
// Manager+ at the race's location.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  // RACEDAY.3 — the location embed is pinned to a NAMED fk on purpose.
  // race_events has TWO foreign keys to locations (location_id and
  // sending_location_id), so a bare `locations ( name )` is ambiguous and
  // PostgREST answers PGRST201/300 — which would take the WHOLE race-day
  // control board down, not merely the studio name it was added for. Nothing
  // local catches that: the tests run on mocked supabase, and lint and the
  // build never see PostgREST's resolution rules.
  //
  // The name feeds the mobile board's offsite banner, which has to say which
  // studio the operator needs to be standing in.
  const db = createServerClient()
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select(`
      id, name, location_id, race_date, kind, allowed_team_sizes,
      waves:race_waves ( id, start_time, capacity, label, display_order ),
      location:locations!race_events_location_id_fkey ( name )
    `)
    .eq('id', params.id)
    .single()
  if (raceErr || !race) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, race.location_id)
  if (guard) return guard

  // Mig 122 (E7): the race-day control panel is race-specific by
  // design — it shows the start/finish/reset workflow for live race
  // timing. Non-race kinds have no equivalent operator surface so
  // we 404 here to match the page-level redirect (so direct API
  // hits behave the same as navigating to the page).
  if (race.kind && race.kind !== 'race') {
    return NextResponse.json({
      success: false,
      error: `The race-day control board is only available for race events (this is a ${race.kind}).`,
    }, { status: 404 })
  }

  // Mig 124: penalties[] embedded inline so the polling UI can sum
  // them client-side without a second roundtrip per team. Ordered by
  // applied_at so the manage-penalties list reads chronologically.
  const { data: registrations, error: regErr } = await db
    .from('race_registrations')
    .select(`
      id, status, race_started_at, race_finished_at, registered_at, wave_id,
      team_composition,
      teams ( id, name, size, captain_contact_id,
        team_members ( id, name, email, role, is_member, member_validation_status )
      ),
      penalties:race_penalties ( id, seconds, reason, applied_by, applied_at )
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
