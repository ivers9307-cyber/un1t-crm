// POST /api/public/events/[slug]/register
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
import { normalizeCode, computeDiscountCents, promoCodeError } from '@/lib/promo-codes'
import { createRacePayment, refreshRacePaymentFromProvider } from '@/lib/race-payments'
import { sendRaceConfirmations } from '@/lib/race-confirmations'
import { getAppUrl } from '@/lib/app-url'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { writeContactTags } from '@/lib/contact-tags'
import { triggerSequencesForRaceRegistered } from '@/lib/sequences'
import { logWarn } from '@/lib/log'
import { wouldFit, spotsLeft } from '@/lib/event-signups'
import { LIVE_REGISTRATION_STATUSES } from '@/lib/audience-filter'
import { eventIsPublic, resolveMasterLocationId } from '@/lib/host-events'

export const runtime = 'nodejs'

const RegisterSchema = z.object({
  // team_name / team_size / wave_id are required for race + the
  // ticketed kinds, but NOT for lead_gen (a name/email/phone capture
  // form with no team or wave). They're optional at the schema layer;
  // the handler enforces them for non-lead_gen kinds.
  team_name: z.string().trim().min(1).max(200).optional(),
  team_size: z.number().int().positive().max(50).optional(),
  wave_id: z.string().uuid().optional(),
  captain_name: z.string().trim().min(1).max(200),
  captain_email: z.string().email().max(320),
  // Phone is REQUIRED for event signups (operator follow-up / race-day
  // contact). Trim, require >= 7 digits so an empty or junk value is
  // rejected even if the client check is bypassed.
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
  // CONSENT.4 — soft opt-in for marketing comms. Defaulted true
  // client-side; missing/undefined here is treated as true to
  // preserve back-compat for older form deployments still in cache.
  marketing_consent: z.boolean().optional(),
  // EVENTS-PROMO.1 — optional discount code applied to the ticket amount.
  promo_code: z.string().trim().max(64).optional(),
})

export async function POST(request, props) {
  const params = await props.params;
  const db = createServerClient()

  const ip = getClientIp(request)
  // SAAS-6: tenant-keyed (the event slug; shared prefix with the races
  // register route) — one tenant's registrations can never consume
  // another tenant's window for the same IP.
  const limit = await checkRateLimit(db, `race-register:${params.slug}:${ip}`, { max: 5, windowMs: 15 * 60_000 })
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
      id, location_id, name, slug, race_date, kind, capacity_mode, allowed_team_sizes,
      registration_opens_at, registration_closes_at, active, status,
      member_pricing_enabled, member_fee_cents, non_member_fee_cents,
      members_only, payment_currency, create_in_glofox, host_id,
      waves:race_waves ( id, start_time, capacity, label )
    `)
    .eq('slug', params.slug)
    .eq('active', true)
    .eq('status', 'published')
    .single()
  if (raceErr || !race) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }

  // Belt-and-suspenders: never take a booking for a non-public
  // (unapproved host) event, even if the status=published filter above
  // were ever bypassed. Same 404 shape as a missing race.
  if (!race || !eventIsPublic(race)) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }

  // HOST-MASTER.4 — third-party host events place/match contacts at the org
  // MASTER location (Stillorgan), exempt-on-create; internal events unchanged.
  // Teams/registrations/payments stay keyed on the EVENT's location — only
  // where the contact rows live changes.
  let hostRow = null
  if (race.host_id) {
    const { data } = await db
      .from('event_hosts')
      .select('id, organization_id, anchor_location_id')
      .eq('id', race.host_id)
      .maybeSingle()
    hostRow = data || null
  }
  const contactLocationId = hostRow ? (await resolveMasterLocationId(db, hostRow) || race.location_id) : race.location_id
  const contactInsertFields = hostRow ? { automations_exempt: true } : {}

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

  // ─── lead_gen: pure data-capture form ───────────────────────────
  // No team, no wave, no payment. Capture name+email+phone, create a
  // confirmed 1-person registration (so it shows in the event roster +
  // count), drop the contact into the sales funnel with a per-event
  // slug tag + a generic 'lead_gen' tag, and return success.
  if (race.kind === 'lead_gen') {
    const leadName = (body.captain_name || '').trim()
    const leadEmail = body.captain_email.toLowerCase().trim()
    const leadPhone = (body.captain_phone || '').trim()

    const contactId = await findOrCreateRaceContact({
      db, locationId: contactLocationId, email: leadEmail, name: leadName, phone: leadPhone,
      insertFields: contactInsertFields,
    })
    if (!contactId) {
      return NextResponse.json({ success: false, error: 'Could not capture your details. Please try again.' }, { status: 500 })
    }

    // Marketing consent (best-effort, same as the main path).
    try {
      const consent = body.marketing_consent !== false
      const { applyFormMarketingConsent } = await import('@/lib/marketing-consent')
      await applyFormMarketingConsent(db, { contactId, consent, source: 'event_form', ipAddress: ip, locationId: contactLocationId })
    } catch (e) { logWarn('lead-gen', 'marketing consent write error', { err: e }) }

    // Funnel tags — per-event slug tag + generic lead_gen tag. Both
    // idempotent; fire tag_added sequences exactly once.
    try {
      // HOST-MASTER.4b — tags are contact-scoped, so they live where the
      // CONTACT lives (the master location for host events), not where the
      // event runs; otherwise master-scoped segments never see them.
      await writeContactTags(db, { contactId, locationId: contactLocationId, tags: [`leadgen-${race.slug}`, 'lead_gen'] })
    } catch (e) { logWarn('lead-gen', 'tag write failed', { err: e }) }

    // Already captured for this form? Idempotent success (no dup row).
    const { data: dupe } = await db
      .from('race_registrations')
      .select('id, registered_at')
      .eq('race_event_id', race.id)
      .eq('contact_id', contactId)
      .eq('status', 'confirmed')
      .maybeSingle()
    if (dupe) {
      return NextResponse.json({
        success: true,
        data: { registration_id: dupe.id, registered_at: dupe.registered_at, race: { id: race.id, name: race.name, slug: race.slug }, payment: { free: true } },
        message: `You're already on the list for ${race.name}.`,
      })
    }

    // Synthetic 1-person team (team_id is NOT NULL on the registration).
    // Name includes the email so two leads with the same name don't
    // collide on the (location_id, name) unique constraint.
    const leadTeamName = `${leadName || 'Lead'} \u2014 ${leadEmail}`
    let teamId
    const { data: foundTeam } = await db.from('teams').select('id').eq('location_id', race.location_id).eq('name', leadTeamName).maybeSingle()
    if (foundTeam) {
      teamId = foundTeam.id
      await db.from('teams').update({ size: 1, captain_contact_id: contactId }).eq('id', teamId)
    } else {
      const { data: ins, error: teamErr } = await db.from('teams').insert({ location_id: race.location_id, name: leadTeamName, size: 1, captain_contact_id: contactId }).select('id').single()
      if (teamErr && teamErr.code === '23505') {
        // K8 — `.maybeSingle()`, matching the find-first query above: the
        // conflicting row can be gone again by the time we re-read, and the
        // `if (!teamId)` path below is what handles that. (location_id, name)
        // is uniquely indexed — it is the very constraint we just tripped.
        const { data: re } = await db.from('teams').select('id').eq('location_id', race.location_id).eq('name', leadTeamName).maybeSingle()
        teamId = re?.id
      } else if (teamErr) {
        return NextResponse.json({ success: false, error: 'Could not capture your details. Please try again.' }, { status: 500 })
      } else { teamId = ins.id }
    }

    // Roster = just the lead.
    await db.from('team_members').delete().eq('team_id', teamId)
    await db.from('team_members').insert({
      team_id: teamId, contact_id: contactId, name: leadName, email: leadEmail,
      role: 'captain', is_member: false, member_validation_status: 'not_applicable',
    })

    const { data: reg, error: regErr } = await db.from('race_registrations').insert({
      race_event_id: race.id, team_id: teamId, contact_id: contactId,
      status: 'confirmed', wave_id: null, team_composition: 'all_non_members',
      // HOST-CONSENT.1 — persisted so the attendee sync can grant HOST consent.
      marketing_consent: body.marketing_consent !== false,
    }).select('id, registered_at').single()
    if (regErr) {
      return NextResponse.json({ success: false, error: 'Could not capture your details. Please try again.' }, { status: 500 })
    }

    // Fire race_registered sequences (best-effort).
    try { await triggerSequencesForRaceRegistered(reg.id) } catch (e) { logWarn('lead-gen', 'race_registered trigger failed', { err: e }) }

    return NextResponse.json({
      success: true,
      data: {
        registration_id: reg.id, registered_at: reg.registered_at, team_id: teamId,
        race: { id: race.id, name: race.name, slug: race.slug },
        payment: { free: true },
      },
      message: `Thanks${leadName ? ' ' + leadName : ''} \u2014 you're on the list.`,
    })
  }

  // Non-lead_gen kinds require a team + wave (schema marks them
  // optional only so the lead_gen body validates).
  if (!body.team_name || !body.team_size || !body.wave_id) {
    return NextResponse.json({ success: false, error: 'Missing registration details.' }, { status: 400 })
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
    // EVENTS-CAPACITY-MODE.1 — enforce the wave cap by teams (one per
    // registration, legacy default) or by people (sum of team sizes).
    const mode = race.capacity_mode === 'people' ? 'people' : 'teams'
    const waveLabel = wave.label || wave.start_time.slice(0, 5)
    if (mode === 'people') {
      // eslint-disable-next-line guardrails/no-uncapped-supabase-limit -- wave-capacity gate; a single race wave never holds >1000 registrations
      const { data: waveRegs } = await db
        .from('race_registrations')
        .select('status, team:teams ( size )')
        .eq('race_event_id', race.id)
        .eq('wave_id', wave.id)
        // Count reserved-but-unpaid spots too, else concurrent paid signups oversell.
        .in('status', LIVE_REGISTRATION_STATUSES)
        .limit(2000)
      if (!wouldFit(wave.capacity, waveRegs || [], 'people', body.team_size)) {
        const left = spotsLeft(wave.capacity, waveRegs || [], 'people')
        const error = left > 0
          ? `Only ${left} ${left === 1 ? 'spot' : 'spots'} left in the ${waveLabel} wave — a group of ${body.team_size} won't fit. Pick another.`
          : `The ${waveLabel} wave is full. Pick another.`
        return NextResponse.json({ success: false, error, code: 'wave_full' }, { status: 409 })
      }
    } else {
      const { count } = await db
        .from('race_registrations')
        .select('*', { count: 'exact', head: true })
        .eq('race_event_id', race.id)
        .eq('wave_id', wave.id)
        .eq('status', 'confirmed')
      if ((count || 0) >= wave.capacity) {
        return NextResponse.json({
          success: false,
          error: `The ${waveLabel} wave is full. Pick another.`,
          code: 'wave_full',
        }, { status: 409 })
      }
    }
  }

  // Find-or-create the captain contact via the shared helper.
  // CLASSIFY.2: lead_status is decommissioned; new contacts are
  // inserted without a stage and pick one up when a deal is later
  // attached (via the mig 155 trigger).
  const captainEmail = body.captain_email.toLowerCase().trim()
  const captainContactId = await findOrCreateRaceContact({
    db,
    locationId: contactLocationId,
    email: captainEmail,
    name: body.captain_name,
    phone: body.captain_phone || null,
    insertFields: contactInsertFields,
  })
  if (!captainContactId) {
    return NextResponse.json({
      success: false,
      error: 'Could not create captain contact.',
    }, { status: 500 })
  }

  // Re-book handling moved BELOW, after the team is resolved — the real
  // uniqueness is (race_event_id, team_id), so we key the resume/replace
  // logic on the team, not the captain's contact. A person is NOT blocked
  // from booking again (different team name = a new booking).

  // CONSENT.4 — soft opt-in for marketing comms. Applies to the
  // captain (the only contact whose phone we collect and the
  // registrant of record). Helper short-circuits for ClassPass
  // contacts. Best-effort — never blocks the registration response.
  try {
    const consent = body.marketing_consent !== false  // default true
    const { applyFormMarketingConsent } = await import('@/lib/marketing-consent')
    await applyFormMarketingConsent(db, {
      contactId: captainContactId,
      consent,
      source:    'event_form',
      ipAddress: ip,
      // HOST-MASTER.4: contacts for host events live at the org's master
      // location, so the consent relationship belongs there too — matching
      // the writeContactTags call above.
      locationId: contactLocationId,
    })
  } catch (e) {
    logWarn('event-register', 'marketing consent write error', { err: e })
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
        // K8 — `.maybeSingle()`: see the solo branch above. 0 rows is handled
        // by the `if (!teamId)` 500 immediately below, so it must not arrive
        // as a discarded error. (location_id, name) is uniquely indexed.
        const { data: raceFound } = await db
          .from('teams')
          .select('id')
          .eq('location_id', race.location_id)
          .eq('name', teamName)
          .maybeSingle()
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

  // ─── re-book handling (EVENTS-REBOOK) ─────────────────────────────
  // A team holds at most ONE registration per event (UNIQUE
  // (race_event_id, team_id)); teams are keyed by name, so re-submitting
  // the same team name lands on the same team. Instead of the old hard
  // "a registration already exists" error we:
  //   • pending_payment + a still-pending payment → RESUME it: return the
  //     existing payment so the buyer is sent back to their OWN
  //     /event-pay link and finishes the booking they started, never
  //     double-charged ("utilise the pending booking link");
  //   • confirmed (already paid) → genuine duplicate for THIS team, block
  //     (they can still book again under a different team name);
  //   • any other stale state (cancelled / no_show / abandoned, or pending
  //     with no usable payment) → discard the row so the fresh
  //     registration can take the (event, team) slot.
  // Different team name ⇒ a different team ⇒ a fresh booking, so the same
  // person can book multiple times.
  {
    const { data: teamReg } = await db
      .from('race_registrations')
      .select('id, status, active_payment_id')
      .eq('race_event_id', race.id)
      .eq('team_id', teamId)
      .maybeSingle()
    if (teamReg) {
      // Resolve the true, current state before deciding. For a pending
      // booking we refresh the payment from the provider so we don't
      // resume a DEAD checkout session: a Stripe Checkout Session expires
      // (~24h) and a Revolut order can lapse, after which our row still
      // reads 'pending' but the buyer's link no longer works. The refresh
      // flips a lapsed session to abandoned/cancelled (or catches a
      // just-completed one) inline.
      let regStatus = teamReg.status
      let livePaymentId = null
      if (teamReg.status === 'pending_payment' && teamReg.active_payment_id) {
        const { data: pay } = await db
          .from('race_payments')
          .select('id, status, payment_provider, payment_provider_ref, connected_account_id')
          .eq('id', teamReg.active_payment_id)
          .maybeSingle()
        if (pay) {
          let refreshed = pay
          if (pay.status === 'pending') {
            try {
              refreshed = (await refreshRacePaymentFromProvider(db, pay)) || pay
            } catch {
              // Provider unreachable — trust the DB view (treat as live).
              refreshed = pay
            }
          }
          if (refreshed.status === 'pending') {
            livePaymentId = refreshed.id           // session still live → resume it
          } else if (refreshed.status === 'completed') {
            regStatus = 'confirmed'                // paid in the meantime
          }
          // failed / abandoned / expired → livePaymentId null → re-register
        }
      }

      if (regStatus === 'confirmed') {
        return NextResponse.json({
          success: false,
          error: `Team "${teamName}" is already registered for ${race.name}.`,
          code: 'already_registered',
        }, { status: 409 })
      }
      if (livePaymentId) {
        return NextResponse.json({
          success: true,
          data: {
            registration_id: teamReg.id,
            team_id: teamId,
            team_name: teamName,
            race: { id: race.id, name: race.name, race_date: race.race_date, slug: race.slug },
            payment: { id: livePaymentId, free: false, status: 'pending', resumed: true },
          },
          message: `You've already started booking Team "${teamName}" — complete payment to confirm.`,
        })
      }
      // Stale/dead row (lapsed session, cancelled, no_show, abandoned, or
      // pending with no usable payment): clear it so the flow below inserts
      // a fresh registration and mints a NEW payment session.
      await db.from('race_registrations').delete().eq('id', teamReg.id)
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

  // ── Promo code (EVENTS-PROMO.1) ──────────────────────────────────────────
  // Applied to the ticket amount BEFORE the per-ticket booking fee. A bad code
  // is rejected so the customer sees why; a valid one reduces pricing.total_cents
  // (which drives the free-vs-paid branch + the charge). Redemption is recorded
  // after the registration is created. Note: a 100%-off / free-total code makes
  // the booking fully free (no booking fee) via the existing amount<=0 path.
  let appliedPromo = null
  let promoDiscountCents = 0
  const rawPromo = normalizeCode(body.promo_code)
  if (rawPromo) {
    // Exact match on the normalized (uppercased) code — never ILIKE with raw
    // customer input (a '%' would wildcard-match any code).
    const { data: code } = await db
      .from('promo_codes')
      .select('id, event_id, discount_type, discount_value, max_redemptions, redeemed_count, member_only, expires_at, active')
      .eq('location_id', race.location_id)
      .eq('code', rawPromo)
      .maybeSingle()
    const err = code
      ? promoCodeError(code, { eventId: race.id, isMemberOrder: (pricing.member_count || 0) > 0 })
      : 'That code isn’t valid.'
    if (err) {
      return NextResponse.json({ success: false, error: err, code: 'invalid_promo_code' }, { status: 400 })
    }
    promoDiscountCents = computeDiscountCents(code, pricing.total_cents)
    pricing.total_cents = Math.max(0, pricing.total_cents - promoDiscountCents)
    appliedPromo = code
  }

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
        locationId: contactLocationId,
        email: m.email,
        name: m.name,
        insertFields: contactInsertFields,
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
      promo_code_id: appliedPromo?.id || null,
      promo_discount_cents: appliedPromo ? promoDiscountCents : null,
      // HOST-CONSENT.1 — persisted so the attendee sync can grant HOST consent
      // when the registration confirms (immediately for free, on payment for paid).
      marketing_consent: body.marketing_consent !== false,
    })
    .select('id, registered_at, wave_id, contact_id')
    .single()

  if (regErr) {
    if (regErr.code === '23505' || /duplicate key|unique/i.test(regErr.message || '')) {
      return NextResponse.json({
        success: false,
        error: `A registration already exists for this event. If this is you, check your email for the confirmation/payment link.`,
        code: 'already_registered',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: regErr.message }, { status: 500 })
  }

  // Record the promo redemption (best-effort — the booking already succeeded).
  // redeemed_count counts applications; the cap pre-check above keeps it near
  // the limit under normal (low-concurrency) load.
  if (appliedPromo) {
    try {
      await db.from('promo_codes')
        .update({ redeemed_count: (appliedPromo.redeemed_count || 0) + 1 })
        .eq('id', appliedPromo.id)
    } catch (e) {
      logWarn('race-register', 'promo redeemed_count increment failed', { err: e })
    }
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
    const returnUrl = `${baseUrl}/event/${race.slug}/confirmed?registration=${registration.id}`
    // Stripe-hosted checkout needs a cancel target (buyer backs out); Revolut
    // ignores it. Send them back to the event page.
    const cancelUrl = `${baseUrl}/event/${race.slug}`
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
      cancelUrl,
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

  // GLOFOX3.3 (mig 145). When the event is opted in AND the
  // registration is already confirmed (free entry), push every team
  // member with a contact to Glofox in create-and-trial mode. For
  // paid registrations we DON'T push here — the Revolut webhook
  // flips status to 'confirmed' after payment lands, and the push
  // fires from there (see /api/webhooks/revolut for the post-pay
  // path). Pushing pre-payment would create Glofox accounts for
  // teams that abandon checkout.
  // Fire-and-forget; failures land in glofox_push_events for the
  // operator's Review tab (mig 143).
  if (race.create_in_glofox && paymentResult.checkout.free) {
    ;(async () => {
      try {
        const { findOrCreateGlofoxMember } = await import('@/lib/glofox-push')
        // Pull every team_member row we just inserted. team_members
        // already point at contact_id (mig 086) — only push members
        // with a contact_id (i.e. those who supplied an email).
        const { data: members } = await db
          .from('team_members')
          .select(`
            name, email, role, contact_id,
            contacts:contact_id ( id, name, email, first_name, last_name, phone, dob, location_id, glofox_member_id )
          `)
          .eq('team_id', teamId)
        for (const m of (members || [])) {
          if (!m.contacts || !m.contacts.id || !m.contacts.email) continue
          const c = m.contacts
          // Split name → first/last if either is missing (Glofox
          // /2.0/register insists on both).
          let { first_name, last_name } = c
          if ((!first_name || !last_name) && (c.name || m.name)) {
            const full = (c.name || m.name).trim().split(/\s+/)
            first_name = first_name || full[0] || ''
            last_name = last_name || (full.slice(1).join(' ') || '—')
          }
          try {
            await findOrCreateGlofoxMember({
              db,
              locationId: c.location_id,
              contact: { ...c, first_name, last_name },
              source: 'event_registration',
              createIfMissing: true,
              attachTrial: true,
            })
          } catch (e) {
            logWarn('race-register.glofox', `push failed for ${c.email}`, { err: e })
          }
        }
      } catch (e) {
        logWarn('race-register.glofox', `team-member fetch failed`, { err: e })
      }
    })()
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
