// /api/races/[id]/teams
//
// GET   — list all registrations for a race with team + members
// POST  — manually create a team registration (no payment flow)
//
// Manager+ at the race's location.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { triggerSequencesForRaceRegistered } from '@/lib/sequences'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateTeamSchema = z.object({
  team_name: z.string().trim().min(1).max(200),
  team_size: z.number().int().positive().max(50),
  wave_id: z.string().uuid(),
  members: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().email().max(320).nullable().optional(),
    role: z.enum(['captain', 'member']).optional(),
  })).min(1).max(50),
})

async function loadRaceForAccess(db, raceId) {
  return db
    .from('race_events')
    .select('id, location_id, allowed_team_sizes, waves:race_waves ( id )')
    .eq('id', raceId)
    .single()
}

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: race, error: raceErr } = await loadRaceForAccess(db, params.id)
  if (raceErr || !race) return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, race.location_id)
  if (guard) return guard

  const { data: registrations, error } = await db
    .from('race_registrations')
    .select(`
      id, status, registered_at, team_composition, wave_id,
      race_started_at, race_finished_at,
      teams:team_id (
        id, name, size, captain_contact_id,
        team_members ( id, name, email, role, is_member, member_validation_status )
      ),
      wave:wave_id ( id, start_time, label )
    `)
    .eq('race_event_id', params.id)
    .order('registered_at', { ascending: true })

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: registrations || [] })
}

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const validation = await validateBody(request, CreateTeamSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: race, error: raceErr } = await loadRaceForAccess(db, params.id)
  if (raceErr || !race) return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, race.location_id)
  if (guard) return guard

  // Validate team size against allowed sizes.
  if (Array.isArray(race.allowed_team_sizes) && !race.allowed_team_sizes.includes(body.team_size)) {
    return NextResponse.json({
      success: false,
      error: `Team size must be one of ${race.allowed_team_sizes.join(', ')}.`,
    }, { status: 400 })
  }
  if (body.members.length !== body.team_size) {
    return NextResponse.json({
      success: false,
      error: `Member count (${body.members.length}) doesn't match team size (${body.team_size}).`,
    }, { status: 400 })
  }
  // Validate wave belongs to this race.
  const waveIds = (race.waves || []).map((w) => w.id)
  if (!waveIds.includes(body.wave_id)) {
    return NextResponse.json({
      success: false,
      error: 'Selected wave does not belong to this race.',
    }, { status: 400 })
  }

  // Find-or-create the team. Captain is the first member with role=captain
  // (or the first member if none specified). Captain's contact is
  // resolved via findOrCreateRaceContact (CLASSIFY.2: no stage set on
  // insert; deal trigger populates pipeline_stage_slug later).
  const teamName = body.team_name.trim()
  const captainIdx = body.members.findIndex((m) => m.role === 'captain')
  const captain = body.members[captainIdx >= 0 ? captainIdx : 0]
  let captainContactId = null
  if (captain.email) {
    captainContactId = await findOrCreateRaceContact({
      db,
      locationId: race.location_id,
      email: captain.email,
      name: captain.name,
    })
  }

  // Find-or-create the team by (location_id, name).
  let teamId
  const { data: foundTeam } = await db
    .from('teams')
    .select('id')
    .eq('location_id', race.location_id)
    .eq('name', teamName)
    .maybeSingle()
  if (foundTeam) {
    teamId = foundTeam.id
    await db.from('teams').update({ size: body.team_size, captain_contact_id: captainContactId }).eq('id', teamId)
  } else {
    const { data: inserted, error: teamErr } = await db
      .from('teams')
      .insert({
        location_id: race.location_id,
        name: teamName,
        size: body.team_size,
        captain_contact_id: captainContactId,
      })
      .select('id')
      .single()
    if (teamErr) {
      return NextResponse.json({
        success: false,
        error: `Could not create team: ${teamErr.message}`,
      }, { status: 500 })
    }
    teamId = inserted.id
  }

  // Reset members. Operator-added teams skip member-validation —
  // is_member stays false, member_validation_status='not_applicable'.
  // EVERY member with an email gets find-or-create contact linkage
  // (mig 086) so race results map back to contact profiles.
  await db.from('team_members').delete().eq('team_id', teamId)
  const captainPos = captainIdx >= 0 ? captainIdx : 0
  const memberRows = []
  for (let i = 0; i < body.members.length; i++) {
    const m = body.members[i]
    const normalisedEmail = m.email ? m.email.toLowerCase().trim() : null
    let contactId = i === captainPos ? captainContactId : null
    if (!contactId && normalisedEmail) {
      contactId = await findOrCreateRaceContact({
        db,
        locationId: race.location_id,
        email: normalisedEmail,
        name: m.name,
      })
    }
    memberRows.push({
      team_id: teamId,
      contact_id: contactId,
      name: m.name,
      email: normalisedEmail,
      role: i === captainPos ? 'captain' : 'member',
      is_member: false,
      member_validation_status: 'not_applicable',
    })
  }
  await db.from('team_members').insert(memberRows)

  // Insert the registration. Manual ops-added teams are status=confirmed
  // immediately — no payment flow. metadata flags this as manual so
  // future reports can distinguish operator-added vs public signups.
  const { data: registration, error: regErr } = await db
    .from('race_registrations')
    .insert({
      race_event_id: params.id,
      team_id: teamId,
      contact_id: captainContactId,
      wave_id: body.wave_id,
      status: 'confirmed',
      team_composition: 'all_non_members',
    })
    .select('id, registered_at')
    .single()

  if (regErr) {
    if (regErr.code === '23505' || /duplicate|unique/i.test(regErr.message || '')) {
      return NextResponse.json({
        success: false,
        error: `Team "${teamName}" is already registered for this race.`,
        code: 'already_registered',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: regErr.message }, { status: 500 })
  }

  // Fire the race_registered sequence trigger (Tier 1A). Best-effort.
  try {
    await triggerSequencesForRaceRegistered(registration.id)
  } catch (e) {
    console.warn(`[races-teams] race_registered trigger failed: ${e?.message || e}`)
  }

  return NextResponse.json({
    success: true,
    data: {
      registration_id: registration.id,
      team_id: teamId,
      registered_at: registration.registered_at,
    },
  })
}
