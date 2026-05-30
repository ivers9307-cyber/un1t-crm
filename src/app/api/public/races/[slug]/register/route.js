// POST /api/public/races/[slug]/register
//
// Public team registration for a standalone race event. No auth.
// Rate-limited per IP same as /api/public/book.
//
// Flow (mig 084 update — adds member validation + payment kickoff):
//   1. Validate body shape
//   2. Look up race by slug; check it's active + within registration window
//   3. Validate team_size against allowed_team_sizes
//   4. Wave validation (mig 083) + per-wave capacity check
//   5. Find-or-create the captain contact
//   6. Find-or-create the team by (location_id, name); update size
//   7. Validate every member's email against UN1T members (mig 084)
//   8. members_only race? — refuse if any non-member detected
//   9. Compute pricing per head (member_fee × verified + non_member_fee × rest)
//  10. Refresh team_members with is_member + member_contact_id stamps
//  11. Insert race_registration row (status = pending_payment if paid,
//      confirmed if free)
//  12. Create race_payment + Revolut order (or mark paid for free entry)
//  13. Return either { payment_url, payment_token, payment_id } for the
//      embedded checkout, or { confirmed: true } for free entries.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { validateTeamRoster, computeTeamPricing } from '@/lib/member-validation'
import { createRacePayment } from '@/lib/race-payments'
import { sendRaceConfirmations } from '@/lib/race-confirmations'
import { getAppUrl } from '@/lib/app-url'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { triggerSequencesForRaceRegistered } from '@/lib/sequences'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const RegisterSchema = z.object({
  team_name: z.string().trim().min(1).max(200),
  team_size: z.number().int().positive().max(50),
  // Wave selection (mig 083) — required since every race has at
  // least one wave. Validated server-side against the parent race.
  wave_id: z.string().uuid(),
  captain_name: z.string().trim().min(1).max(200),
  captain_email: z.string().email().max(320),
  // Phone REQUIRED (parity with /events register). >= 7 digits.
  captain_phone: z
    .string()
    .trim()
    .min(1, 'Phone number is required')
    .max(50)
    .refine((v) => v.replace(/\D/g, '').length >= 7, 'Enter a valid phone number'),
  members: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().email().max(320).nullable().optional(),
  })).max(50).optional(),
  source: z.string().max(50).optional(),
})

export async function POST(request, props) {
  const params = await props.params;
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
  // round-trip. Also pulls the new pricing fields (mig 084).
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select(`
      id, location_id, name, slug, race_date, allowed_team_sizes,
      registration_opens_at, registration_closes_at, active,
      member_pricing_enabled, member_fee_cents, non_member_fee_cents,
      members_only, payment_currency,
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

  // Find-or-create the captain contact via the shared helper.
  // CLASSIFY.2: lead_status is decommissioned; new contacts are
  // inserted without a stage and pick one up when a deal is later
  // attached (via the mig 155 trigger).
  const captainEmail = body.captain_email.toLowerCase().trim()
  const captainContactId = await findOrCreateRaceContact({
    db,
    locationId: race.location_id,
    email: captainEmail,
    name: body.captain_name,
    phone: body.captain_phone || null,
  })
  if (!captainContactId) {
    return NextResponse.json({
      success: false,
      error: 'Could not create captain contact.',
    }, { status: 500 })
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

  // ─── member validation (mig 084) ─────────────────────────────────
  // Compose the full roster (captain + others) and check each email
  // against UN1T members. Validation only matters when member pricing
  // is enabled OR the race is members_only — otherwise everyone is a
  // non-member by default and we skip the per-email contacts query.
  const fullRoster = [
    { name: body.captain_name, email: captainEmail },
    ...(body.members || []).map((m) => ({
      name: m.name,
      email: m.email ? m.email.toLowerCase().trim() : null,
    })),
  ]

  let validatedRoster
  if (race.member_pricing_enabled || race.members_only) {
    validatedRoster = await validateTeamRoster({
      db,
      members: fullRoster,
      locationId: race.location_id,
    })
  } else {
    validatedRoster = fullRoster.map((m) => ({
      name: m.name,
      email: m.email,
      is_member: false,
      member_contact_id: null,
      status: 'not_applicable',
    }))
  }

  // members_only gate. Reject if any team member couldn't be verified.
  if (race.members_only) {
    const unverified = validatedRoster.filter((m) => !m.is_member)
    if (unverified.length > 0) {
      const names = unverified.map((m) => m.name || '(unnamed)').join(', ')
      return NextResponse.json({
        success: false,
        error: `This race is open to UN1T members only. We couldn't verify membership for: ${names}. Each team member must use the email on their UN1T account.`,
        code: 'members_only_unverified',
        unverified_emails: unverified.map((m) => m.email).filter(Boolean),
      }, { status: 403 })
    }
  }

  // Pricing breakdown.
  const pricing = computeTeamPricing({ validatedRoster, race })

  // Refresh team_members for THIS registration's roster, stamping
  // member-validation results AND contact_id linkage (mig 086).
  // Every member with an email gets a find-or-create contact lookup
  // — not just the captain — so race results show up on every
  // competitor's profile. Verified UN1T members already have
  // member_contact_id set; we still call findOrCreateRaceContact
  // because the contact_id column on team_members is the canonical
  // "who is this person" pointer.
  await db.from('team_members').delete().eq('team_id', teamId)
  const memberRows = []
  for (let idx = 0; idx < validatedRoster.length; idx++) {
    const m = validatedRoster[idx]
    let contactId = idx === 0 ? captainContactId : null
    if (!contactId && m.email) {
      contactId = await findOrCreateRaceContact({
        db,
        locationId: race.location_id,
        email: m.email,
        name: m.name,
      })
    }
    memberRows.push({
      team_id: teamId,
      contact_id: contactId,
      name: m.name,
      email: m.email,
      role: idx === 0 ? 'captain' : 'member',
      is_member: !!m.is_member,
      member_validation_status: m.status,
      member_contact_id: m.member_contact_id || null,
      member_validated_at: m.status === 'verified' ? new Date().toISOString() : null,
    })
  }
  await db.from('team_members').insert(memberRows)

  // Create the race_registration. Paid races start as pending_payment;
  // free races (total_cents=0) jump straight to confirmed via the
  // payment helper below.
  const initialStatus = pricing.total_cents > 0 ? 'pending_payment' : 'confirmed'
  const { data: registration, error: regErr } = await db
    .from('race_registrations')
    .insert({
      race_event_id: race.id,
      team_id: teamId,
      contact_id: captainContactId,
      status: initialStatus,
      wave_id: wave.id,
      team_composition: pricing.team_composition,
    })
    .select('id, registered_at, wave_id, contact_id')
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

  // Fire the race_registered sequence trigger (Tier 1A). Best-effort —
  // never blocks the registration response. Enrols every team member
  // with a contact_id, not just the captain.
  try {
    await triggerSequencesForRaceRegistered(registration.id)
  } catch (e) {
    logWarn('race-register', `race_registered trigger failed`, { err: e })
  }

  // ─── kick off the payment (or mark paid for free entry) ──────────
  let paymentResult
  try {
    const baseUrl = getAppUrl()
    const returnUrl = `${baseUrl}/race/${race.slug}/confirmed?registration=${registration.id}`
    paymentResult = await createRacePayment({
      db,
      race,
      registration,
      captain: {
        name: body.captain_name,
        email: captainEmail,
        phone: body.captain_phone || null,
      },
      pricing,
      returnUrl,
    })
  } catch (e) {
    // Roll back the registration so the team can retry — leaving a
    // pending_payment row with no payment is operator confusion.
    await db.from('race_registrations').delete().eq('id', registration.id)
    return NextResponse.json({
      success: false,
      error: `Could not start payment: ${e.message || 'unknown error'}`,
      code: 'payment_init_failed',
    }, { status: 502 })
  }

  // Free entry — fire confirmations immediately. Best-effort, never
  // fails the response.
  if (paymentResult.checkout.free) {
    try {
      await sendRaceConfirmations({ db, paymentId: paymentResult.payment.id })
    } catch (e) {
      logWarn('race-register', `free-entry confirmations failed`, { err: e })
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      registration_id: registration.id,
      registered_at: registration.registered_at,
      team_id: teamId,
      team_name: teamName,
      race: { id: race.id, name: race.name, race_date: race.race_date, slug: race.slug },
      pricing: {
        total_cents: pricing.total_cents,
        currency: race.payment_currency || 'EUR',
        member_count: pricing.member_count,
        non_member_count: pricing.non_member_count,
        member_fee_cents: pricing.member_fee_cents,
        non_member_fee_cents: pricing.non_member_fee_cents,
      },
      payment: {
        id: paymentResult.payment.id,
        free: paymentResult.checkout.free,
        token: paymentResult.checkout.token,
        url: paymentResult.checkout.url,
        status: paymentResult.payment.status,
      },
    },
    message: paymentResult.checkout.free
      ? `Team "${teamName}" registered for ${race.name}.`
      : `Team "${teamName}" registered — complete payment to confirm.`,
  })
}
