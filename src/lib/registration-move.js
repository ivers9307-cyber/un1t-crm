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
import {
  MOVE_ERRORS, MOVE_ERROR_MESSAGES, membersOf,
  entryLabel, entryHeadcount, perPersonFeeCents, computePriceGapCents,
} from './registration-entry'

// The pure, browser-safe helpers live in registration-entry.js (a client
// component imports them from there); re-exported so server callers and
// tests have one import path.
export {
  MOVE_ERRORS, MOVE_ERROR_MESSAGES,
  entryLabel, entryHeadcount, perPersonFeeCents, computePriceGapCents,
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
  if (registration.race_started_at || registration.race_finished_at) return fail(MOVE_ERRORS.CHECKED_IN)
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

/**
 * The entry with its lead contact, team, roster and source event.
 * { registration, error }: error is set only when the read FAILED, so the
 * caller can tell "no such entry" (not_found) from "could not read it"
 * (load_failed).
 */
async function readRegistrationForMove(db, registrationId) {
  const { data, error } = await db
    .from('race_registrations')
    .select(`
      id, status, race_event_id, wave_id, team_id, contact_id, registered_at,
      race_started_at, race_finished_at,
      contact:contact_id ( id, first_name, last_name, email, location_id ),
      teams:team_id ( id, name, size, location_id,
        team_members ( id, name, email, role, is_member, contact_id ) ),
      wave:wave_id ( id, start_time, label ),
      race:race_event_id ( ${EVENT_COLUMNS} )
    `)
    .eq('id', registrationId)
    .maybeSingle()
  if (error) {
    logError('registration-move', 'entry load failed', { err: error, registrationId })
    return { registration: null, error }
  }
  return { registration: data || null, error: null }
}

/** The entry for the routes: the row, or null (missing or unreadable). */
export async function loadRegistrationForMove(db, registrationId) {
  const { registration } = await readRegistrationForMove(db, registrationId)
  return registration
}

/** The not_found / load_failed refusal for a read that produced no entry. */
function entryReadRefusal(error) {
  return { ok: false, error: error ? MOVE_ERRORS.LOAD_FAILED : MOVE_ERRORS.NOT_FOUND }
}

async function loadEvent(db, eventId) {
  const { data, error } = await db.from('race_events').select(EVENT_COLUMNS).eq('id', eventId).maybeSingle()
  if (error) {
    logError('registration-move', 'target load failed', { err: error, eventId })
    return null
  }
  return data || null
}

const WAVE_PAGE = 1000

/**
 * Live rows in the given waves, shaped for event-signups' counters, in ONE
 * query paged past the 1,000-row cap. { rows, error }: on a failed read the
 * caller refuses (load_failed); an empty-looking wave would pass a full one.
 */
async function loadWaveRegistrations(db, waveIds) {
  const ids = [...new Set((waveIds || []).filter(Boolean))]
  if (ids.length === 0) return { rows: [], error: null }
  const rows = []
  for (let from = 0; ; from += WAVE_PAGE) {
    const { data, error } = await db
      .from('race_registrations')
      .select('id, status, wave_id, team:teams!team_id ( size )')
      .in('wave_id', ids)
      .in('status', ['confirmed', 'pending_payment'])
      .order('id')
      .range(from, from + WAVE_PAGE - 1)
    if (error) {
      logError('registration-move', 'wave load failed', { err: error, waveCount: ids.length })
      return { rows: null, error }
    }
    rows.push(...(data || []))
    if (!data || data.length < WAVE_PAGE) break
  }
  return { rows, error: null }
}

function groupByWave(rows) {
  const byWave = new Map()
  for (const r of rows || []) {
    if (!byWave.has(r.wave_id)) byWave.set(r.wave_id, [])
    byWave.get(r.wave_id).push(r)
  }
  return byWave
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
  const { registration, error: readErr } = await readRegistrationForMove(db, registrationId)
  if (!registration) return entryReadRefusal(readErr)
  const source = registration.race

  // Payee and studio are filtered in the query so the row cap applies to
  // eligible events only; the JS checks below stay as a belt.
  let query = db
    .from('race_events')
    .select(EVENT_COLUMNS)
    .eq('active', true)
    .eq('status', 'published')
    .gte('race_date', today)
  query = source?.host_id ? query.eq('host_id', source.host_id) : query.is('host_id', null)
  if (Array.isArray(allowedLocationIds)) query = query.in('location_id', allowedLocationIds)
  const { data: events, error } = await query
    .order('race_date', { ascending: true })
    .limit(200)
  if (error) {
    logError('registration-move', 'targets load failed', { err: error, registrationId })
    return { ok: false, error: MOVE_ERRORS.LOAD_FAILED }
  }

  const members = membersOf(registration)
  const headcount = entryHeadcount(registration)
  const eligible = (events || []).filter((ev) => {
    if (ev.id === source?.id) return false
    if (!samePayee(source, ev)) return false
    if (allowedEventIds && !allowedEventIds.has(ev.id)) return false
    if (Array.isArray(allowedLocationIds) && !allowedLocationIds.includes(ev.location_id)) return false
    // The same rule as evaluateMove's headcount_not_allowed: never offer it.
    const sizes = ev.allowed_team_sizes
    if (Array.isArray(sizes) && sizes.length > 0 && !sizes.includes(headcount)) return false
    return true
  })

  const { rows: waveRows, error: waveErr } = await loadWaveRegistrations(db, eligible.flatMap((ev) => (ev.waves || []).map((w) => w.id)))
  if (waveErr) return { ok: false, error: MOVE_ERRORS.LOAD_FAILED }
  const byWave = groupByWave(waveRows)

  const targets = []
  for (const ev of eligible) {
    const mode = ev.capacity_mode === 'people' ? 'people' : 'teams'
    const waves = sortWaves(ev.waves).map((w) => ({
      id: w.id, start_time: w.start_time, label: w.label, capacity: w.capacity,
      spots_left: spotsLeft(w.capacity, byWave.get(w.id) || [], mode),
    }))
    targets.push({
      id: ev.id, name: ev.name, race_date: ev.race_date, kind: ev.kind,
      location_id: ev.location_id, location_name: ev.locations?.name || '',
      crosses_studio: (ev.location_id || null) !== (source?.location_id || null),
      capacity_mode: mode,
      price_gap_cents: computePriceGapCents({ sourceEvent: source, targetEvent: ev, members, headcount }),
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

/** move_race_registration's re-check under the row lock (mig 708): P0003. */
function isConflict(err) {
  if (!err) return false
  return err.code === 'P0003' || /\bconflict\b/i.test(String(err.message || ''))
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
  // Who moved it is recorded on every move (registration_moves.actor_type
  // is NOT NULL, checked to staff/host/agent): a caller that omits it is a
  // bug, not a refusal to show the operator.
  if (!actor?.type) throw new TypeError('actor.type is required')
  const { registration, error: readErr } = await readRegistrationForMove(db, registrationId)
  if (!registration) return entryReadRefusal(readErr)
  // Outside the host's own events: 404, the host fence.
  if (allowedEventIds && !allowedEventIds.has(targetEventId)) return { ok: false, error: MOVE_ERRORS.NOT_FOUND }

  // A missing or unreadable target is the target's problem, not the entry's.
  const targetEvent = await loadEvent(db, targetEventId)
  if (!targetEvent) return { ok: false, error: MOVE_ERRORS.TARGET_UNAVAILABLE }
  const targetWave = targetWaveId ? (targetEvent.waves || []).find((w) => w.id === targetWaveId) || { id: targetWaveId, race_event_id: null } : null

  const [waveRead, checkinCount, existingOnTarget] = await Promise.all([
    targetWave?.race_event_id ? loadWaveRegistrations(db, [targetWave.id]) : Promise.resolve({ rows: [], error: null }),
    countCheckins(db, registrationId),
    findExistingOnTarget(db, { teamId: registration.team_id, targetEventId, registrationId }),
  ])
  if (waveRead.error) return { ok: false, error: MOVE_ERRORS.LOAD_FAILED }
  // One wave was asked for, so every row is that wave's.
  const targetWaveRegistrations = waveRead.rows

  const verdict = evaluateMove({
    registration, sourceEvent: registration.race, targetEvent, targetWave,
    targetWaveRegistrations, checkinCount, existingOnTarget, force, today,
  })
  if (!verdict.ok) return verdict

  const members = membersOf(registration)
  const headcount = entryHeadcount(registration)
  const priceGapCents = computePriceGapCents({ sourceEvent: registration.race, targetEvent, members, headcount })
  const { data: move, error: rpcErr } = await db.rpc('move_race_registration', {
    p_registration_id: registrationId,
    // The event the rules were judged against: the function re-checks it
    // under the row lock and raises 'conflict' if the entry moved meanwhile.
    p_from_event_id: registration.race_event_id,
    p_to_event_id: targetEventId,
    p_to_wave_id: targetWave?.id || null,
    p_headcount: headcount,
    p_price_gap_cents: priceGapCents,
    p_forced: force === true,
    p_actor_type: actor.type,
    p_actor_id: actor?.id || null,
    p_actor_name: actor?.name || '',
    p_note: note || null,
  })
  if (rpcErr || !move) {
    if (isConflict(rpcErr)) {
      logWarn('registration-move', 'entry changed under the move; refused as conflict', { err: rpcErr, registrationId, targetEventId })
      return { ok: false, error: MOVE_ERRORS.CONFLICT }
    }
    logError('registration-move', 'move_race_registration failed', { err: rpcErr, registrationId, targetEventId })
    return { ok: false, error: MOVE_ERRORS.WRITE_FAILED }
  }

  // After-effects: each in its own try, none may fail the move.
  // The lead contact's email; a team is never assumed, so the roster is
  // only a fallback (captain, then the first member with an email).
  const leadEmail = registration.contact?.email
    || members.find((m) => m?.role === 'captain')?.email
    || members.find((m) => m?.email)?.email
    || null
  if (!leadEmail) {
    logWarn('registration-move', 'no email on the entry; race.moved contact event skipped', { registrationId, moveId: move.id })
  } else {
    try {
      await emitEvent({
        db, eventType: EVENT_TYPES.RACE_MOVED, contactEmail: leadEmail,
        contactId: registration.contact_id || null, locationId: targetEvent.location_id || null,
        sourceType: 'race_registration', sourceId: registrationId,
        metadata: { from_event_id: registration.race_event_id, to_event_id: targetEventId, move_id: move.id, forced: force === true, price_gap_cents: priceGapCents },
      })
    } catch (e) { logWarn('registration-move', 'contact event failed', { err: e, registrationId }) }
  }
  try {
    // The timeline line sits at the contact's home studio (where staff read
    // their timeline), else the studio the entry was booked at.
    const timelineLocationId = registration.contact?.location_id || registration.race?.location_id || null
    if (registration.contact_id && timelineLocationId) {
      const { error: actErr } = await db.from('activities').insert({
        contact_id: registration.contact_id, location_id: timelineLocationId, kind: 'event', type: 'event',
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
