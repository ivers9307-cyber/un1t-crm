// AGENT-EVENTS.2 — solo (team-of-1) event registration for the
// customer agent. Mirrors the public register route's flow using the
// SAME building blocks (validateTeamRoster, computeTeamPricing,
// findOrCreateRaceContact-equivalent contact, createRacePayment,
// sendRaceConfirmations) so capacity, member gates, pricing, the
// payment row and confirmations behave identically to the website.
// The route itself is untouched — zero regression risk there.
//
// PAID entries are never completed here: payment lives on the public
// signup page's Revolut widget, so a non-zero total returns
// requires_payment and the agent shares the link. Team entries also
// stay on the page (Richard's call: captain/solo only via chat).

import { validateTeamRoster, computeTeamPricing } from '@/lib/member-validation'
import { createRacePayment } from '@/lib/race-payments'
import { sendRaceConfirmations } from '@/lib/race-confirmations'
import { getAppUrl } from '@/lib/app-url'
import { wouldFit } from '@/lib/event-signups'
import { LIVE_REGISTRATION_STATUSES } from '@/lib/audience-filter'

/**
 * Register one person for an event when it's FREE for them.
 *
 * @param {object} db     service-role client
 * @param {object} args
 * @param {object} args.race     race_events row incl. waves, fees, slug, location_id
 * @param {string|null} args.waveId
 * @param {object} args.contact  { id, name, first_name, last_name, email, phone }
 * @param {boolean} [args.memberOverride]  PERSON-ACCT.4 — the caller has
 *   already determined (across the entrant's whole person group, via
 *   hasBookableMembership) that this person holds a real bookable
 *   membership, even if it lives on a SIBLING contacts row the email-based
 *   validateMemberByEmail lookup below can't see (it only matches the one
 *   email on this roster entry). When true, the entrant counts as a member
 *   for pricing/members-only regardless of what that lookup returns. Default
 *   false preserves the original email-only behaviour for every other
 *   caller (the membership-requests draft executor does not pass it).
 * @returns one of:
 *   { ok: true, registrationId }
 *   { ok: false, reason: 'closed'|'not_open_yet'|'past'|'inactive'|'bad_wave'|
 *     'wave_full'|'need_email'|'members_only'|'requires_payment'|
 *     'already_registered'|'db_error', totalCents?, message? }
 */
export async function registerSoloEventEntry(db, { race, waveId, contact, memberOverride = false }) {
  if (!race || !contact?.id) return { ok: false, reason: 'db_error', message: 'missing args' }

  const email = String(contact.email || '').trim().toLowerCase()
  if (!email) return { ok: false, reason: 'need_email' }
  const fullName = String(
    contact.name || `${contact.first_name || ''} ${contact.last_name || ''}`,
  ).trim() || 'Solo entry'

  // Wave checks — mirror the route: the wave must belong to this race
  // and have space (non-cancelled registrations vs capacity).
  const waves = race.waves || []
  let wave = null
  if (waveId) {
    wave = waves.find((w) => w.id === waveId) || null
    if (!wave) return { ok: false, reason: 'bad_wave' }
  } else if (waves.length === 1) {
    wave = waves[0]
  } else if (waves.length > 1) {
    return { ok: false, reason: 'bad_wave', message: 'Pick a wave — this event has more than one start time.' }
  }
  if (wave?.capacity != null) {
    // EVENTS-CAPACITY-MODE.1 — teams = one per registration, people = sum
    // of team sizes. A solo entry adds exactly one of whichever unit.
    // Mirrors the public register route's gate.
    const mode = race.capacity_mode === 'people' ? 'people' : 'teams'
    // eslint-disable-next-line guardrails/no-uncapped-supabase-limit -- wave-capacity gate; a single race wave never holds >1000 registrations
    const { data: waveRegs } = await db.from('race_registrations')
      .select('status, team:teams ( size )')
      .eq('wave_id', wave.id)
      // Count reserved-but-unpaid spots too, else concurrent paid signups oversell.
      .in('status', LIVE_REGISTRATION_STATUSES)
      .limit(2000)
    if (!wouldFit(wave.capacity, waveRegs || [], mode, 1)) return { ok: false, reason: 'wave_full' }
  }

  // Member validation + pricing — identical to the route.
  const roster = [{ name: fullName, email }]
  let validatedRoster
  if (race.member_pricing_enabled || race.members_only) {
    validatedRoster = await validateTeamRoster({ db, members: roster, locationId: race.location_id })
  } else {
    validatedRoster = roster.map((m) => ({
      name: m.name, email: m.email, is_member: false, member_contact_id: null, status: 'not_applicable',
    }))
  }
  // PERSON-ACCT.4 — see the memberOverride jsdoc above. Solo entry only, so
  // this always affects the one roster row.
  if (memberOverride) {
    validatedRoster = validatedRoster.map((m) => ({ ...m, is_member: true }))
  }
  if (race.members_only && validatedRoster.some((m) => !m.is_member)) {
    return { ok: false, reason: 'members_only' }
  }
  const pricing = computeTeamPricing({ validatedRoster, race })
  if (pricing.total_cents > 0) {
    return { ok: false, reason: 'requires_payment', totalCents: pricing.total_cents }
  }

  // Team find-or-create by (location_id, name) — the route's exact
  // pattern including the UNIQUE-violation race.
  let teamId
  const { data: foundTeam } = await db.from('teams')
    .select('id')
    .eq('location_id', race.location_id)
    .eq('name', fullName)
    .maybeSingle()
  if (foundTeam) {
    teamId = foundTeam.id
    await db.from('teams').update({ size: 1, captain_contact_id: contact.id }).eq('id', teamId)
  } else {
    const { data: insertedTeam, error: teamErr } = await db.from('teams')
      .insert({ location_id: race.location_id, name: fullName, size: 1, captain_contact_id: contact.id })
      .select('id')
      .single()
    if (teamErr) {
      if (teamErr.code === '23505') {
        // K8 — `.maybeSingle()`: the unique-violation refetch. 0 rows falls
        // through to the `if (!teamId)` db_error return below, so it must not
        // arrive as a discarded error. (location_id, name) is uniquely indexed.
        const { data: again } = await db.from('teams')
          .select('id').eq('location_id', race.location_id).eq('name', fullName).maybeSingle()
        teamId = again?.id
      }
      if (!teamId) return { ok: false, reason: 'db_error', message: teamErr.message }
    } else {
      teamId = insertedTeam.id
    }
  }

  // Roster row for the race-day UI.
  await db.from('team_members').delete().eq('team_id', teamId)
  await db.from('team_members').insert({
    team_id: teamId,
    contact_id: contact.id,
    name: fullName,
    email,
    role: 'captain',
    is_member: !!validatedRoster[0]?.is_member,
    member_validation_status: validatedRoster[0]?.status || 'not_applicable',
    member_contact_id: validatedRoster[0]?.member_contact_id || null,
    member_validated_at: validatedRoster[0]?.status === 'verified' ? new Date().toISOString() : null,
  })

  // Registration — free entries are confirmed immediately. The UNIQUE
  // (race_event_id, team_id) makes a double-book a clean error.
  const { data: registration, error: regErr } = await db.from('race_registrations')
    .insert({
      race_event_id: race.id,
      team_id: teamId,
      contact_id: contact.id,
      wave_id: wave?.id || null,
      status: 'confirmed',
    })
    .select('id, registered_at')
    .single()
  if (regErr) {
    if (regErr.code === '23505') return { ok: false, reason: 'already_registered' }
    return { ok: false, reason: 'db_error', message: regErr.message }
  }

  // Free-entry payment row + confirmations — the route's exact tail.
  try {
    const baseUrl = getAppUrl()
    const paymentResult = await createRacePayment({
      db,
      race,
      registration,
      captain: { name: fullName, email, phone: contact.phone || null },
      pricing,
      returnUrl: `${baseUrl}/race/${race.slug}/confirmed?registration=${registration.id}`,
    })
    if (paymentResult?.checkout?.free) {
      try {
        await sendRaceConfirmations({ db, paymentId: paymentResult.payment.id })
      } catch (e) {
        console.warn('[race-register-solo] confirmations failed:', e?.message || e)
      }
    }
  } catch (e) {
    // The registration stands; the payment row is bookkeeping for a
    // €0 entry — log loudly rather than unwind a confirmed spot.
    console.error('[race-register-solo] free payment row failed:', e?.message || e)
  }

  return { ok: true, registrationId: registration.id }
}
