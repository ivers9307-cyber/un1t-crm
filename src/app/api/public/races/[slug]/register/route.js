// POST /api/public/races/[slug]/register
//
// Public team registration for a standalone race event. No auth.
// Rate-limited per IP same as /api/public/book.
//
// Flow:
//   1. Validate body shape
//   2. Look up race by slug; check it's active + within registration window
//   3. Validate team_size against allowed_team_sizes
//   4. Capacity check (if set) — soft race against concurrent signups
//      is acceptable for v1; we just count current confirmed regs
//   5. Find-or-create the captain contact (the booking system has a
//      DB trigger for bookings; race_registrations doesn't yet, so
//      we do it explicitly here)
//   6. Find-or-create the team by (location_id, name); update size
//   7. Refresh team_members (clear + re-insert captain + N-1 members)
//   8. Insert race_registration row

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'

const RegisterSchema = z.object({
  team_name: z.string().trim().min(1).max(200),
  team_size: z.number().int().positive().max(50),
  // Wave selection (mig 083) — required since every race has at
  // least one wave. Validated server-side against the parent race.
  wave_id: z.string().uuid(),
  captain_name: z.string().trim().min(1).max(200),
  captain_email: z.string().email().max(320),
  captain_phone: z.string().max(50).nullable().optional(),
  members: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().email().max(320).nullable().optional(),
  })).max(50).optional(),
  source: z.string().max(50).optional(),
})

export async function POST(request, { params }) {
  const db = createServerClient()

  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `race-register:${ip}`, { max: 5, windowMs: 15 * 60_000 })
  if (!limit.allowed) {
    return rateLimitResponse(limit, 'Too many registration attempts. Please wait a few minutes and try again.')
  }

  const validation = await validateBody(request, RegisterSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Look up the race — must be active. Joins waves so we can validate
  // wave_id belongs to this race and check per-wave capacity in one
  // round-trip.
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select(`
      id, location_id, name, slug, race_date, allowed_team_sizes,
      registration_opens_at, registration_closes_at, active,
      waves:race_waves ( id, start_time, capacity, label )
    `)
    .eq('slug', params.slug)
    .eq('active', true)
    .single()
  if (raceErr || !race) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }

  // Registration-window check.
  const now = Date.now()
  if (race.registration_opens_at && now < Date.parse(race.registration_opens_at)) {
    return NextResponse.json({
      success: false,
      error: 'Registration has not opened yet for this race.',
      code: 'not_open',
      opens_at: race.registration_opens_at,
    }, { status: 409 })
  }
  if (race.registration_closes_at && now > Date.parse(race.registration_closes_at)) {
    return NextResponse.json({
      success: false,
      error: 'Registration has closed for this race.',
      code: 'closed',
    }, { status: 409 })
  }

  // Team size validation.
  if (Array.isArray(race.allowed_team_sizes) && !race.allowed_team_sizes.includes(body.team_size)) {
    return NextResponse.json({
      success: false,
      error: `Team size must be one of ${race.allowed_team_sizes.join(', ')} for this race.`,
    }, { status: 400 })
  }
  const expectedMemberCount = body.team_size - 1
  const memberCount = Array.isArray(body.members) ? body.members.length : 0
  if (memberCount !== expectedMemberCount) {
    return NextResponse.json({
      success: false,
      error: `Expected ${expectedMemberCount} member(s) for a team of ${body.team_size} (captain is the registrant).`,
    }, { status: 400 })
  }

  // Wave validation (mig 083). The submitted wave_id must belong to
  // this race; we then check the wave's capacity rather than a race-
  // wide cap.
  const wave = (race.waves || []).find((w) => w.id === body.wave_id)
  if (!wave) {
    return NextResponse.json({
      success: false,
      error: 'Selected wave does not belong to this race.',
      code: 'invalid_wave',
    }, { status: 400 })
  }
  if (wave.capacity != null) {
    const { count } = await db
      .from('race_registrations')
      .select('*', { count: 'exact', head: true })
      .eq('race_event_id', race.id)
      .eq('wave_id', wave.id)
      .eq('status', 'confirmed')
    if ((count || 0) >= wave.capacity) {
      return NextResponse.json({
        success: false,
        error: `The ${wave.label || wave.start_time.slice(0, 5)} wave is full. Pick another.`,
        code: 'wave_full',
      }, { status: 409 })
    }
  }

  // Find-or-create the captain contact. The booking flow uses a DB
  // trigger; race_registrations doesn't have one yet, so do it
  // explicitly. Match by (location_id, lower(email)).
  const captainEmail = body.captain_email.toLowerCase().trim()
  let captainContactId = null
  const { data: existingContact } = await db
    .from('contacts')
    .select('id')
    .eq('location_id', race.location_id)
    .ilike('email', captainEmail)
    .maybeSingle()
  if (existingContact) {
    captainContactId = existingContact.id
  } else {
    const { data: insertedContact, error: contactErr } = await db
      .from('contacts')
      .insert({
        location_id: race.location_id,
        name: body.captain_name,
        email: captainEmail,
        phone: body.captain_phone || null,
        source: body.source || 'race_signup',
      })
      .select('id')
      .single()
    if (contactErr) {
      return NextResponse.json({
        success: false,
        error: `Could not create contact: ${contactErr.message}`,
      }, { status: 500 })
    }
    captainContactId = insertedContact.id
  }

  // Find-or-create the team by (location_id, name).
  const teamName = body.team_name.trim()
  let teamId
  const { data: foundTeam } = await db
    .from('teams')
    .select('id')
    .eq('location_id', race.location_id)
    .eq('name', teamName)
    .maybeSingle()
  if (foundTeam) {
    teamId = foundTeam.id
    await db.from('teams').update({
      size: body.team_size,
      captain_contact_id: captainContactId,
    }).eq('id', teamId)
  } else {
    const { data: insertedTeam, error: teamErr } = await db
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
      // UNIQUE violation race — refetch and continue.
      if (teamErr.code === '23505') {
        const { data: raceFound } = await db
          .from('teams')
          .select('id')
          .eq('location_id', race.location_id)
          .eq('name', teamName)
          .single()
        teamId = raceFound?.id
      }
      if (!teamId) {
        return NextResponse.json({
          success: false,
          error: `Could not create team: ${teamErr.message}`,
        }, { status: 500 })
      }
    } else {
      teamId = insertedTeam.id
    }
  }

  // Refresh team_members for THIS registration's roster. Same
  // semantics as the (now-deprecated) booking-flow team handling.
  await db.from('team_members').delete().eq('team_id', teamId)
  const memberRows = [
    {
      team_id: teamId,
      contact_id: captainContactId,
      name: body.captain_name,
      email: captainEmail,
      role: 'captain',
    },
    ...(body.members || []).map((m) => ({
      team_id: teamId,
      contact_id: null,
      name: m.name,
      email: m.email ? m.email.toLowerCase().trim() : null,
      role: 'member',
    })),
  ]
  await db.from('team_members').insert(memberRows)

  // Create the race_registration. UNIQUE (race_event_id, team_id)
  // means a returning team can't double-register — surface as 409.
  const { data: registration, error: regErr } = await db
    .from('race_registrations')
    .insert({
      race_event_id: race.id,
      team_id: teamId,
      contact_id: captainContactId,
      status: 'confirmed',
      wave_id: wave.id,
    })
    .select('id, registered_at, wave_id')
    .single()

  if (regErr) {
    if (regErr.code === '23505' || /duplicate key|unique/i.test(regErr.message || '')) {
      return NextResponse.json({
        success: false,
        error: `Team "${teamName}" is already registered for this race.`,
        code: 'already_registered',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: regErr.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: {
      registration_id: registration.id,
      registered_at: registration.registered_at,
      team_id: teamId,
      team_name: teamName,
      race: { id: race.id, name: race.name, race_date: race.race_date, slug: race.slug },
    },
    message: `Team "${teamName}" registered for ${race.name}.`,
  })
}
