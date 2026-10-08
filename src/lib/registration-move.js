// registration-move — move an event ENTRY (one race_registrations row: its
// people, its payment, its history) to another event. EVENT-MOVE.1.
//
// The unit is the entry, never the team: today every entry is a team (a solo
// is a team of one), and team-less single bookings are coming. Nothing here
// may assume `teams` is set.
//
// Split: the RULES are pure functions in this file (unit-tested with plain
// objects); the WRITES are one Postgres function, move_race_registration
// (mig 708), so a half-applied move cannot exist. Money is never touched: a
// price gap is computed, recorded and shown, nothing more.
//
// Spec: docs/superpowers/specs/2026-10-08-event-entry-move-design.md

import { wouldFit, spotsLeft } from './event-signups'
import { dublinTodayStr } from './dublin-time'
import { logError, logWarn } from './log'
import { emitEvent, EVENT_TYPES } from './contact-events'
import { addEventAttendeesToHostList } from './host-contact-list'

export const MOVE_ERRORS = Object.freeze({
  NOT_FOUND: 'not_found',
  NOT_ACTIVE: 'not_active',
  CHECKED_IN: 'checked_in',
  SAME_EVENT: 'same_event',
  TARGET_UNAVAILABLE: 'target_unavailable',
  DIFFERENT_PAYEE: 'different_payee',
  ALREADY_ENTERED: 'already_entered',
  HEADCOUNT_NOT_ALLOWED: 'headcount_not_allowed',
  WAVE_REQUIRED: 'wave_required',
  WRONG_EVENT: 'wrong_event',
  WAVE_FULL: 'wave_full',
})

// Plain-English for the dialog. Keyed by code so the route never invents copy.
export const MOVE_ERROR_MESSAGES = Object.freeze({
  not_found: 'That entry no longer exists.',
  not_active: 'Only a confirmed entry or one awaiting payment can be moved.',
  checked_in: 'Someone on this entry has already checked in, so it cannot move.',
  same_event: 'That is the event the entry is already on. Use the wave select to change its time.',
  target_unavailable: 'The target event is not published or has already happened.',
  different_payee: 'The target event is paid to a different host, so the payment cannot follow.',
  already_entered: 'This team already has an entry on the target event (a cancelled one counts).',
  headcount_not_allowed: 'The target event does not accept an entry of this size.',
  wave_required: 'Pick a time on the target event.',
  wrong_event: 'That time does not belong to the target event.',
  wave_full: 'That time is full.',
})

/** The team row's live roster, if loaded. Never assumes a team. */
function membersOf(registration) {
  const list = registration?.teams?.team_members
  return Array.isArray(list) ? list : []
}

/**
 * What the UI calls an entry: the team name for a team of two or more, else
 * the person (captain, lead contact), else "Entry".
 */
export function entryLabel(registration) {
  const team = registration?.teams || null
  const members = membersOf(registration)
  if (team?.name && (members.length > 1 || (members.length === 0 && Number(team.size) > 1))) return team.name
  const captain = members.find((m) => m?.role === 'captain') || members[0]
  if (captain?.name) return captain.name
  const c = registration?.contact
  const contactName = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim()
  if (contactName) return contactName
  if (team?.name) return team.name
  return 'Entry'
}

/** People on the entry: the loaded roster, else teams.size, else 1. */
export function entryHeadcount(registration) {
  const members = membersOf(registration)
  if (members.length > 0) return members.length
  const size = Number(registration?.teams?.size)
  return Number.isFinite(size) && size > 0 ? size : 1
}

/** Per-person ticket price on an event for a member / non-member, in cents. */
export function perPersonFeeCents(event, isMember) {
  const nonMember = Number(event?.non_member_fee_cents) || 0
  if (!event?.member_pricing_enabled) return nonMember
  return isMember ? (Number(event?.member_fee_cents) || 0) : nonMember
}

/**
 * (target per-person − source per-person) summed over the people on the
 * entry. Signed; 0 when prices match. A roster of zero (team-less entry)
 * counts as one non-member.
 */
export function computePriceGapCents({ sourceEvent, targetEvent, members }) {
  const roster = Array.isArray(members) && members.length > 0 ? members : [{ is_member: false }]
  let gap = 0
  for (const m of roster) {
    const isMember = m?.is_member === true
    gap += perPersonFeeCents(targetEvent, isMember) - perPersonFeeCents(sourceEvent, isMember)
  }
  return gap
}

const LIVE_STATUSES = new Set(['confirmed', 'pending_payment'])

/** Same payee when host_id matches, NULL (UN1T on Revolut) equal to NULL. */
export function samePayee(a, b) {
  return (a?.host_id || null) === (b?.host_id || null)
}

/**
 * Every rule in the spec's table, in order, on already-loaded rows. Pure.
 *
 * @param {object} args
 * @param {object} args.registration   race_registrations row with teams.team_members
 * @param {object} args.sourceEvent    race_events row
 * @param {object} args.targetEvent    race_events row with waves[]
 * @param {object|null} args.targetWave   race_waves row (null when none given)
 * @param {Array} args.targetWaveRegistrations  live rows in that wave ({status, team:{size}})
 * @param {number} args.checkinCount   race_checkins rows for the entry
 * @param {object|null} args.existingOnTarget  another entry of the same team on the target, any status
 * @param {boolean} [args.force]       true = skip wave_full
 * @param {string} [args.today]        YYYY-MM-DD in Europe/Dublin
 * @returns {{ ok: true } | { ok: false, error: string, spots_left?: number|null }}
 */
export function evaluateMove({
  registration, sourceEvent, targetEvent, targetWave, targetWaveRegistrations,
  checkinCount, existingOnTarget, force = false, today = dublinTodayStr(),
}) {
  const fail = (error, extra = {}) => ({ ok: false, error, ...extra })
  if (!registration) return fail(MOVE_ERRORS.NOT_FOUND)
  if (!LIVE_STATUSES.has(registration.status)) return fail(MOVE_ERRORS.NOT_ACTIVE)
  if ((checkinCount || 0) > 0) return fail(MOVE_ERRORS.CHECKED_IN)
  if (!targetEvent) return fail(MOVE_ERRORS.TARGET_UNAVAILABLE)
  if (targetEvent.id === registration.race_event_id) return fail(MOVE_ERRORS.SAME_EVENT)
  if (targetEvent.active !== true || targetEvent.status !== 'published') return fail(MOVE_ERRORS.TARGET_UNAVAILABLE)
  if (!targetEvent.race_date || String(targetEvent.race_date).slice(0, 10) < today) return fail(MOVE_ERRORS.TARGET_UNAVAILABLE)
  if (!samePayee(sourceEvent, targetEvent)) return fail(MOVE_ERRORS.DIFFERENT_PAYEE)

  // Any row of the same team on the target, cancelled included: UNIQUE
  // (race_event_id, team_id) is not partial, so the write would refuse it.
  // A cross-studio move clones the team, so it cannot collide.
  const crossesStudio = (sourceEvent?.location_id || null) !== (targetEvent.location_id || null)
  if (!crossesStudio && registration.team_id && existingOnTarget) {
    return fail(MOVE_ERRORS.ALREADY_ENTERED)
  }

  const headcount = entryHeadcount(registration)
  const sizes = targetEvent.allowed_team_sizes
  if (Array.isArray(sizes) && sizes.length > 0 && !sizes.includes(headcount)) return fail(MOVE_ERRORS.HEADCOUNT_NOT_ALLOWED)

  const targetHasWaves = Array.isArray(targetEvent.waves) && targetEvent.waves.length > 0
  if (targetHasWaves && !targetWave) return fail(MOVE_ERRORS.WAVE_REQUIRED)
  if (targetWave && targetWave.race_event_id !== targetEvent.id) return fail(MOVE_ERRORS.WRONG_EVENT)

  if (targetWave && !force) {
    const mode = targetEvent.capacity_mode === 'people' ? 'people' : 'teams'
    const regs = Array.isArray(targetWaveRegistrations) ? targetWaveRegistrations : []
    if (!wouldFit(targetWave.capacity, regs, mode, headcount)) {
      return fail(MOVE_ERRORS.WAVE_FULL, { spots_left: spotsLeft(targetWave.capacity, regs, mode) })
    }
  }
  return { ok: true }
}

const EVENT_COLUMNS = `
  id, name, slug, race_date, location_id, host_id, active, status, kind,
  capacity_mode, allowed_team_sizes,
  member_pricing_enabled, member_fee_cents, non_member_fee_cents, payment_currency,
  venue_name, accent_hex, hero_image_url, sending_location_id,
  moved_email_subject, moved_email_intro,
  waves:race_waves ( id, race_event_id, start_time, label, capacity, display_order ),
  locations:location_id ( id, name, is_host_anchor, organization_id )
`

/** The entry with its team, roster and source event. null when missing. */
export async function loadRegistrationForMove(db, registrationId) {
  const { data, error } = await db
    .from('race_registrations')
    .select(`
      id, status, race_event_id, wave_id, team_id, contact_id, registered_at,
      teams:team_id ( id, name, size, location_id,
        team_members ( id, name, email, role, is_member, contact_id ) ),
      wave:wave_id ( id, start_time, label ),
      race:race_event_id ( ${EVENT_COLUMNS} )
    `)
    .eq('id', registrationId)
    .maybeSingle()
  if (error) {
    logError('registration-move', 'entry load failed', { err: error, registrationId })
    return null
  }
  return data || null
}

async function loadEvent(db, eventId) {
  const { data, error } = await db.from('race_events').select(EVENT_COLUMNS).eq('id', eventId).maybeSingle()
  if (error) {
    logError('registration-move', 'target load failed', { err: error, eventId })
    return null
  }
  return data || null
}

/** Live rows in a wave, shaped for event-signups' counters. */
async function loadWaveRegistrations(db, waveId) {
  const { data, error } = await db
    .from('race_registrations')
    .select('id, status, team:teams!team_id ( size )')
    .eq('wave_id', waveId)
    .in('status', ['confirmed', 'pending_payment'])
  if (error) {
    logError('registration-move', 'wave load failed', { err: error, waveId })
    return []
  }
  return data || []
}

async function countCheckins(db, registrationId) {
  const { count, error } = await db
    .from('race_checkins')
    .select('id', { count: 'exact', head: true })
    .eq('race_registration_id', registrationId)
  if (error) {
    logError('registration-move', 'check-in count failed', { err: error, registrationId })
    // Fail toward "checked in": a move we cannot judge must not proceed.
    return 1
  }
  return count || 0
}

async function findExistingOnTarget(db, { teamId, targetEventId, registrationId }) {
  if (!teamId) return null
  const { data, error } = await db
    .from('race_registrations')
    .select('id, status')
    .eq('team_id', teamId)
    .eq('race_event_id', targetEventId)
    .neq('id', registrationId)
    .limit(1)
    .maybeSingle()
  if (error) {
    logError('registration-move', 'existing-entry check failed', { err: error, teamId, targetEventId })
    return { id: null, status: 'confirmed' } // fail closed: treat as taken
  }
  return data || null
}

function sortWaves(waves) {
  return (waves || []).slice().sort((a, b) =>
    (a.display_order ?? 0) - (b.display_order ?? 0) || String(a.start_time || '').localeCompare(String(b.start_time || '')))
}

function entrySummary(registration) {
  const members = membersOf(registration)
  return {
    id: registration.id,
    status: registration.status,
    label: entryLabel(registration),
    headcount: entryHeadcount(registration),
    member_count: members.filter((m) => m?.is_member === true).length,
    non_member_count: members.filter((m) => m?.is_member !== true).length,
    team_id: registration.team_id || null,
  }
}

/**
 * The events an entry may move to, for the dialog's picker: same payee,
 * published, upcoming, not the source, at an allowed studio, with each wave's
 * spots_left and this entry's price gap. Staff-only output (shows capacity).
 *
 * @param {object} db  service-role client
 * @param {object} args
 * @param {string} args.registrationId
 * @param {Set<string>|null} [args.allowedEventIds]   host caller: its own events
 * @param {string[]|null} [args.allowedLocationIds]   staff caller: getUserLocationIds (null = master)
 * @param {string} [args.today]
 */
export async function listMoveTargets(db, { registrationId, allowedEventIds = null, allowedLocationIds = null, today = dublinTodayStr() }) {
  const registration = await loadRegistrationForMove(db, registrationId)
  if (!registration) return { ok: false, error: MOVE_ERRORS.NOT_FOUND }
  const source = registration.race

  const { data: events, error } = await db
    .from('race_events')
    .select(EVENT_COLUMNS)
    .eq('active', true)
    .eq('status', 'published')
    .gte('race_date', today)
    .order('race_date', { ascending: true })
    .limit(200)
  if (error) {
    logError('registration-move', 'targets load failed', { err: error, registrationId })
    return { ok: false, error: 'load_failed' }
  }

  const members = membersOf(registration)
  const targets = []
  for (const ev of events || []) {
    if (ev.id === source?.id) continue
    if (!samePayee(source, ev)) continue
    if (allowedEventIds && !allowedEventIds.has(ev.id)) continue
    if (Array.isArray(allowedLocationIds) && !allowedLocationIds.includes(ev.location_id)) continue
    const mode = ev.capacity_mode === 'people' ? 'people' : 'teams'
    const waves = []
    for (const w of sortWaves(ev.waves)) {
      const regs = await loadWaveRegistrations(db, w.id)
      waves.push({ id: w.id, start_time: w.start_time, label: w.label, capacity: w.capacity, spots_left: spotsLeft(w.capacity, regs, mode) })
    }
    targets.push({
      id: ev.id, name: ev.name, race_date: ev.race_date, kind: ev.kind,
      location_id: ev.location_id, location_name: ev.locations?.name || '',
      crosses_studio: (ev.location_id || null) !== (source?.location_id || null),
      capacity_mode: mode,
      price_gap_cents: computePriceGapCents({ sourceEvent: source, targetEvent: ev, members }),
      currency: ev.payment_currency || source?.payment_currency || 'EUR',
      waves,
    })
  }
  return {
    ok: true,
    entry: entrySummary(registration),
    source: { event_id: source?.id || null, event_name: source?.name || '', race_date: source?.race_date || null, wave_id: registration.wave_id || null, location_id: source?.location_id || null },
    targets,
  }
}

/**
 * Move one entry. Rules first (pure), then the SQL function, then best-effort
 * after-effects that never fail the move.
 *
 * @returns {{ ok: true, move: object, registration: object }
 *         | { ok: false, error: string, spots_left?: number|null }}
 */
export async function moveRegistration(db, {
  registrationId, targetEventId, targetWaveId = null,
  actor, note = null, notify = true, force = false, allowedEventIds = null,
  today = dublinTodayStr(),
}) {
  const registration = await loadRegistrationForMove(db, registrationId)
  if (!registration) return { ok: false, error: MOVE_ERRORS.NOT_FOUND }
  if (allowedEventIds && !allowedEventIds.has(targetEventId)) return { ok: false, error: MOVE_ERRORS.NOT_FOUND }

  const targetEvent = await loadEvent(db, targetEventId)
  if (!targetEvent) return { ok: false, error: MOVE_ERRORS.NOT_FOUND }
  const targetWave = targetWaveId ? (targetEvent.waves || []).find((w) => w.id === targetWaveId) || { id: targetWaveId, race_event_id: null } : null

  const [targetWaveRegistrations, checkinCount, existingOnTarget] = await Promise.all([
    targetWave?.race_event_id ? loadWaveRegistrations(db, targetWave.id) : Promise.resolve([]),
    countCheckins(db, registrationId),
    findExistingOnTarget(db, { teamId: registration.team_id, targetEventId, registrationId }),
  ])

  const verdict = evaluateMove({
    registration, sourceEvent: registration.race, targetEvent, targetWave,
    targetWaveRegistrations, checkinCount, existingOnTarget, force, today,
  })
  if (!verdict.ok) return verdict

  const members = membersOf(registration)
  const priceGapCents = computePriceGapCents({ sourceEvent: registration.race, targetEvent, members })
  const { data: move, error: rpcErr } = await db.rpc('move_race_registration', {
    p_registration_id: registrationId,
    p_to_event_id: targetEventId,
    p_to_wave_id: targetWave?.id || null,
    p_headcount: entryHeadcount(registration),
    p_price_gap_cents: priceGapCents,
    p_forced: force === true,
    p_actor_type: actor?.type || 'staff',
    p_actor_id: actor?.id || null,
    p_actor_name: actor?.name || '',
    p_note: note || null,
  })
  if (rpcErr || !move) {
    logError('registration-move', 'move_race_registration failed', { err: rpcErr, registrationId, targetEventId })
    return { ok: false, error: 'write_failed' }
  }

  // After-effects: each in its own try, none may fail the move.
  const leadEmail = members.find((m) => m?.role === 'captain')?.email || members[0]?.email || null
  try {
    await emitEvent({
      db, eventType: EVENT_TYPES.RACE_MOVED, contactEmail: leadEmail || '',
      contactId: registration.contact_id || null, locationId: targetEvent.location_id || null,
      sourceType: 'race_registration', sourceId: registrationId,
      metadata: { from_event_id: registration.race_event_id, to_event_id: targetEventId, move_id: move.id, forced: force === true, price_gap_cents: priceGapCents },
    })
  } catch (e) { logWarn('registration-move', 'contact event failed', { err: e, registrationId }) }
  try {
    if (registration.contact_id && targetEvent.location_id) {
      const { error: actErr } = await db.from('activities').insert({
        contact_id: registration.contact_id, location_id: targetEvent.location_id, kind: 'event', type: 'event',
        subject: `Entry moved from ${registration.race?.name || 'event'} to ${targetEvent.name} by ${actor?.name || 'staff'}`,
        note: `From ${registration.race?.name || 'event'} (${registration.race?.race_date || ''}) to ${targetEvent.name} (${targetEvent.race_date || ''}).${note ? ` Note: ${note}` : ''}`,
        done: true,
      })
      if (actErr) logWarn('registration-move', 'timeline row failed', { err: actErr, registrationId })
    }
  } catch (e) { logWarn('registration-move', 'timeline row threw', { err: e, registrationId }) }
  try {
    if (targetEvent.host_id) await addEventAttendeesToHostList(db, targetEventId)
  } catch (e) { logWarn('registration-move', 'host contact list sync failed', { err: e, targetEventId }) }
  if (notify) {
    try {
      const { sendRegistrationMovedEmail } = await import('./race-confirmations')
      await sendRegistrationMovedEmail(db, { registrationId, moveId: move.id })
    } catch (e) { logError('registration-move', 'moved email threw; the move stands', { err: e, registrationId, moveId: move.id }) }
  }
  return { ok: true, move, registration: { id: registrationId, race_event_id: targetEventId, wave_id: targetWave?.id || null } }
}
