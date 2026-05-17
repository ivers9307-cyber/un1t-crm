// GET /api/contacts/[id]/races
//
// Returns every race the contact has competed in — captain or
// member. Drives the "Races" section on the contact profile.
//
// Manager+ at the contact's location.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, contact.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  // Find every team_members row for this contact, joined to its team
  // and the race_registrations the team is part of, joined to the
  // parent race_event. One contact_id may appear on multiple teams
  // across multiple races — we surface each race they competed in.
  const { data: rows, error } = await db
    .from('team_members')
    .select(`
      id, name, email, role, is_member,
      team:team_id (
        id, name, size,
        registrations:race_registrations (
          id, status, registered_at,
          race_started_at, race_finished_at, team_composition,
          race:race_event_id ( id, name, slug, race_date, location_id ),
          wave:wave_id ( id, start_time, label )
        )
      )
    `)
    .eq('contact_id', params.id)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // Flatten into one entry per registration, with elapsed time
  // computed where both timestamps exist.
  const out = []
  for (const tm of rows || []) {
    const team = tm.team
    if (!team) continue
    for (const reg of (team.registrations || [])) {
      let elapsedSeconds = null
      if (reg.race_started_at && reg.race_finished_at) {
        const startMs = Date.parse(reg.race_started_at)
        const endMs = Date.parse(reg.race_finished_at)
        if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
          elapsedSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000))
        }
      }
      out.push({
        registration_id: reg.id,
        race: reg.race,
        wave: reg.wave,
        team: { id: team.id, name: team.name, size: team.size },
        member_role: tm.role,
        is_member: tm.is_member,
        registration_status: reg.status,
        registered_at: reg.registered_at,
        race_started_at: reg.race_started_at,
        race_finished_at: reg.race_finished_at,
        elapsed_seconds: elapsedSeconds,
        team_composition: reg.team_composition,
      })
    }
  }

  // Sort newest race first.
  out.sort((a, b) => (b.race?.race_date || '').localeCompare(a.race?.race_date || ''))

  return NextResponse.json({ success: true, data: out })
}
