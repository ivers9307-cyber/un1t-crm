// GET /api/public/event-registrations/[id]
//
// Public — no auth. Read-only summary of a single registration for
// the post-payment confirmation page (/race/[slug]/confirmed).
//
// Privacy: returns ONLY the team-visible fields (team name, size,
// wave, member roster names + role + verified flag). Does NOT
// return the captain's email or phone — even though the buyer just
// went through checkout, exposing PII via a UUID-keyed public route
// would leak if the URL got shared.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function GET(_request, { params }) {
  const db = createServerClient()
  const { data, error } = await db
    .from('race_registrations')
    .select(`
      id, status, registered_at, team_composition,
      race:race_event_id (
        id, name, slug, race_date, location_id,
        locations:location_id ( name, address )
      ),
      wave:wave_id ( id, start_time, label ),
      teams:team_id ( id, name, size,
        team_members ( id, name, role, is_member ) )
    `)
    .eq('id', params.id)
    .maybeSingle()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }

  return NextResponse.json({
    success: true,
    data: {
      id: data.id,
      status: data.status,
      registered_at: data.registered_at,
      team_composition: data.team_composition,
      race: data.race,
      wave: data.wave,
      team: data.teams,
    },
  })
}
