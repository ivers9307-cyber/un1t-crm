// GET /api/contacts/[id]/races
//
// Returns every race the contact has competed in — captain or
// member. Drives the "Events" section on the contact profile.
//
// HOST-MASTER.6b — any session user who can access the contact (was
// Manager+): the profile page itself is staff-visible via
// canViewContact, so the card it feeds shouldn't 403 for staff.
// Gate mirrors the sibling /api/contacts/[id]/* subroutes
// (command-centre / consent-log): getCurrentUser() → load contact →
// location check answering 404 (not 403) so ids can't be enumerated.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const db = createServerClient()
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

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
          race:race_event_id ( id, name, slug, race_date, location_id, host:event_hosts!host_id ( name ) ),
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
        // HOST-MASTER.6b — NULL race_events.host_id = internal UN1T event
        // (mig 381), so hostName is null for those.
        hostName: reg.race?.host?.name || null,
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
