// POST / DELETE /api/events/[id]/checkin — per-person event attendance.
//
// POST   { team_member_id, race_registration_id }  → mark present (idempotent)
// DELETE ?team_member_id=…&race_registration_id=…  → undo
//
// Gated by the 'races' feature permission (door staff use it) + per-location
// access. Writes go through the service-role client; race_checkins has a
// UNIQUE(registration, member) so a double-tap is a no-op. Each check-in
// emits the race.checked_in contact-event (best-effort) for tag rules.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { emitEvent, EVENT_TYPES } from '@/lib/contact-events'
import { checkinCounts } from '@/lib/event-checkins'
import { sumWaveCapacity } from '@/lib/event-signups'

export const runtime = 'nodejs'

const Schema = z.object({
  team_member_id: uuidLike,
  race_registration_id: uuidLike,
})

// Load the registration, confirm it belongs to THIS event, and locate the
// member on its team. Returns { error, status } or { member, locationId }.
async function resolve(db, eventId, registrationId, memberId) {
  const { data: reg } = await db
    .from('race_registrations')
    .select('id, race_event_id, race_events!inner ( id, location_id ), teams ( id, team_members ( id, email, contact_id ) )')
    .eq('id', registrationId)
    .maybeSingle()
  if (!reg || reg.race_event_id !== eventId) {
    return { error: 'Registration not found for this event', status: 404 }
  }
  const locationId = reg.race_events?.location_id
  const member = (reg.teams?.team_members || []).find((m) => m.id === memberId)
  if (!member) return { error: 'That person is not on this registration', status: 400 }
  return { member, locationId }
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Events feature is disabled at this location' }, { status: 403 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { team_member_id, race_registration_id } = validation.data

  const db = createServerClient()
  const r = await resolve(db, params.id, race_registration_id, team_member_id)
  if (r.error) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
  const guard = assertLocationAccess(user, r.locationId)
  if (guard) return guard

  const { error } = await db.from('race_checkins').insert({
    race_registration_id,
    team_member_id,
    contact_id: r.member.contact_id || null,
    location_id: r.locationId,
    checked_in_by: user.id,
  })
  // UNIQUE(registration, member) → a re-tap is a clean no-op, not an error.
  if (error && !/duplicate|unique|23505/i.test(error.message || '')) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  if (r.member.email) {
    await emitEvent({
      db,
      eventType: EVENT_TYPES.RACE_CHECKED_IN,
      contactEmail: r.member.email,
      contactId: r.member.contact_id || null,
      locationId: r.locationId,
      sourceType: 'race_registration',
      sourceId: race_registration_id,
      metadata: { event_id: params.id, team_member_id },
    })
  }

  return NextResponse.json({ success: true, data: { checked_in: true } })
}

export async function DELETE(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Events feature is disabled at this location' }, { status: 403 })
  }

  const url = new URL(request.url)
  const team_member_id = url.searchParams.get('team_member_id') || ''
  const race_registration_id = url.searchParams.get('race_registration_id') || ''
  if (!team_member_id || !race_registration_id) {
    return NextResponse.json({ success: false, error: 'team_member_id and race_registration_id are required' }, { status: 400 })
  }

  const db = createServerClient()
  const r = await resolve(db, params.id, race_registration_id, team_member_id)
  if (r.error) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
  const guard = assertLocationAccess(user, r.locationId)
  if (guard) return guard

  const { error } = await db
    .from('race_checkins')
    .delete()
    .eq('race_registration_id', race_registration_id)
    .eq('team_member_id', team_member_id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data: { checked_in: false } })
}

// GET — the confirmed roster + per-member check-in state + live counts.
// Powers the mobile check-in screen (the web page server-loads its own copy);
// service-role read avoids client-side RLS/embed pitfalls.
export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Events feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select(`
      id, name, location_id, race_date, kind, slug, start_time, capacity, capacity_mode, active,
      waves:race_waves ( id, start_time, label, display_order, capacity ),
      registrations:race_registrations (
        id, status, wave_id,
        teams ( id, name, team_members ( id, name, email, contact_id ) )
      )
    `)
    .eq('id', params.id)
    .single()
  if (!race) return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  const guard = assertLocationAccess(user, race.location_id)
  if (guard) return guard

  const confirmed = (race.registrations || []).filter((r) => r.status === 'confirmed')
  const regIds = confirmed.map((r) => r.id)
  let checkedSet = new Set()
  if (regIds.length) {
    const { data: checks } = await db
      .from('race_checkins')
      .select('race_registration_id, team_member_id')
      .in('race_registration_id', regIds)
    checkedSet = new Set((checks || []).map((c) => `${c.race_registration_id}:${c.team_member_id}`))
  }

  const wavesById = new Map((race.waves || []).map((w) => [w.id, w]))
  const registrations = confirmed
    .map((r) => {
      const w = wavesById.get(r.wave_id)
      return {
        id: r.id,
        wave_label: w ? (w.label || (w.start_time ? String(w.start_time).slice(0, 5) : null)) : null,
        _order: w?.display_order ?? 999,
        team: {
          name: r.teams?.name || 'Entry',
          team_members: (r.teams?.team_members || []).map((m) => ({
            id: m.id,
            name: m.name || m.email || 'Member',
            email: m.email || null,
            checked_in: checkedSet.has(`${r.id}:${m.id}`),
          })),
        },
      }
    })
    .sort((a, b) => a._order - b._order || a.team.name.localeCompare(b.team.name))

  const counts = checkinCounts(registrations.map((r) => ({ status: 'confirmed', team: r.team })))
  return NextResponse.json({
    success: true,
    data: {
      event: {
        id: race.id,
        name: race.name,
        kind: race.kind,
        isRace: (race.kind || 'race') === 'race',
        slug: race.slug,
        race_date: race.race_date,
        start_time: race.start_time,
        capacity: sumWaveCapacity(race.waves) ?? race.capacity,
        capacity_mode: race.capacity_mode,
        active: race.active,
      },
      registrations,
      counts,
    },
  })
}
