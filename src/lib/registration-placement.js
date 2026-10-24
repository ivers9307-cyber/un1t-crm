// FINDTEAM.5 — staff placement for "Find me a team".
//
// A solo entrant registers as a team of one flagged looking_for_team
// (FINDTEAM.3). Staff then either place them into an existing team
// (placeSoloIntoTeam) or pair two or more solos into a new team (pairSolos).
// The solo's own registration is never deleted: it flips to status 'placed'
// with placed_into_registration_id pointing at the team's registration, so the
// payment and the history stay on file.
//
// Write order, both paths: the person is added to the team (and, when placing,
// the team's size and its entry's team_composition are re-set) BEFORE the solo
// row flips. A crash between the two leaves a visible duplicate (the person on
// the team AND still in the queue, which staff can see and tidy), never a lost
// person (flipped to placed and on no team). Every failed write after the first
// is logged with the stage it died at.
//
// FINDTEAM.8 (M1/M2): placing sets the team's size and its entry's
// team_composition from a FRESH read of the team's members after the insert,
// never read-then-+1, so two placements into one team at once cannot lose a
// head. When the guarded flip matches no row (someone placed the solo first),
// this call deletes the member row IT inserted and re-syncs size and
// composition, so the race leaves no duplicate behind.
//
// Neither path reads race_events.find_team: switching the feature off after a
// solo registered must not strand them in the queue.
//
// All tables here are service-role only; the routes enforce access first.

import { spotsLeft, wouldFit } from './event-signups'
import { logError } from './log'

const MODULE = 'registration-placement'

export const PLACEMENT_ERRORS = Object.freeze({
  NOT_FOUND: 'not_found',
  NOT_SOLO: 'not_solo',
  NOT_PAID: 'not_paid',
  ALREADY_PLACED: 'already_placed',
  WRONG_EVENT: 'wrong_event',
  TARGET_NOT_LIVE: 'target_not_live',
  NO_MEMBER_ROW: 'no_member_row',
  TOO_FEW: 'too_few',
  MIXED_WAVES: 'mixed_waves',
  INVALID_WAVE: 'invalid_wave',
  WAVE_FULL: 'wave_full',
  TEAM_NAME_TAKEN: 'team_name_taken',
  LOAD_FAILED: 'load_failed',
  WRITE_FAILED: 'write_failed',
})

export const PLACEMENT_ERROR_MESSAGES = Object.freeze({
  not_found: 'That entry could not be found on this event.',
  not_solo: 'That entry is not a solo entrant looking for a team.',
  not_paid: 'That entrant has not paid yet, so they cannot be placed.',
  already_placed: 'That entrant has already been placed in a team, possibly by someone else just now. Nothing was added. Reload to see where.',
  wrong_event: 'That team is on a different event.',
  target_not_live: 'That team is not a confirmed team entry, so nobody can join it.',
  no_member_row: 'That entry has no person on it, so there is nobody to place.',
  too_few: 'Pick at least two solo entrants to pair.',
  mixed_waves: 'These entrants are in different waves. Pick the wave the new team goes in.',
  invalid_wave: 'That wave is not on this event.',
  wave_full: 'That wave has no team places left.',
  team_name_taken: 'A team with that name already exists. Pick another name.',
  load_failed: 'The entries could not be read. Nothing changed. Try again.',
  write_failed: 'The change could not be saved in full. Reload and check the teams before trying again.',
})

const MEMBER_COLUMNS = 'id, contact_id, name, email, role, is_member, member_validation_status, member_contact_id, member_validated_at'
const SOLO_SELECT = `id, race_event_id, team_id, contact_id, status, wave_id, looking_for_team, placed_into_registration_id, marketing_consent, teams:team_id ( id, team_members ( ${MEMBER_COLUMNS} ) )`
const TARGET_SELECT = 'id, race_event_id, team_id, status, looking_for_team, teams:team_id ( id )'
const WAVE_LOAD_SELECT = 'id, status, looking_for_team, team:teams!team_id ( size )'

const fail = (error, extra = {}) => ({ ok: false, error, ...extra })

function isoOf(now) {
  const d = now instanceof Date ? now : new Date(now ?? Date.now())
  return d.toISOString()
}

/**
 * Why this registration cannot be placed, or null when it can. A placed row is
 * already_placed; a row that never asked for a team, or a cancelled / no-show
 * one, is not_solo; an unpaid one is not_paid.
 * @param {{ status?: string, looking_for_team?: boolean, placed_into_registration_id?: string|null }} reg
 * @returns {string|null}
 */
export function soloRefusal(reg) {
  if (reg.status === 'placed' || reg.placed_into_registration_id) return PLACEMENT_ERRORS.ALREADY_PLACED
  if (!reg.looking_for_team) return PLACEMENT_ERRORS.NOT_SOLO
  if (reg.status === 'pending_payment') return PLACEMENT_ERRORS.NOT_PAID
  if (reg.status !== 'confirmed') return PLACEMENT_ERRORS.NOT_SOLO
  return null
}

/** The solo's one person: the captain row of their team of one. */
function soloPerson(reg) {
  const members = Array.isArray(reg?.teams?.team_members) ? reg.teams.team_members : []
  return members.find((m) => m?.role === 'captain') || members[0] || null
}

/** A team_members row for `person` on `teamId`, copied from the solo's own row. */
function memberRowFor(teamId, reg, person, role) {
  return {
    team_id: teamId,
    contact_id: person.contact_id || reg.contact_id || null,
    name: person.name,
    email: person.email ?? null,
    role,
    is_member: person.is_member === true,
    member_validation_status: person.member_validation_status || 'not_applicable',
    member_contact_id: person.member_contact_id ?? null,
    member_validated_at: person.member_validated_at ?? null,
  }
}

/**
 * 'all_members' when every flag is true, 'all_non_members' when none is,
 * else 'mixed' (race_registrations.team_composition).
 * @param {boolean[]} flags
 */
export function teamCompositionFor(flags) {
  const n = flags.filter((f) => f === true).length
  if (n === flags.length) return 'all_members'
  if (n === 0) return 'all_non_members'
  return 'mixed'
}

/**
 * FINDTEAM.8 (M1/M2) — set a team's size and its entry's team_composition from
 * a fresh read of the team's members. Returns the failed stage, or null.
 * @returns {Promise<null|'team_size'|'team_composition'>}
 */
async function syncTeamFromMembers(db, { teamId, registrationId, meta }) {
  const { data: rows, error: readErr } = await db
    .from('team_members').select('id, is_member').eq('team_id', teamId).limit(500)
  if (readErr || !Array.isArray(rows)) {
    logError(MODULE, 'place: team members re-read failed; team size not set', { err: readErr, teamId, ...meta })
    return 'team_size'
  }
  const { data: sized, error: sizeErr } = await db
    .from('teams').update({ size: rows.length }).eq('id', teamId).select('id')
  if (sizeErr || !Array.isArray(sized) || sized.length === 0) {
    logError(MODULE, 'place: team size update failed', { err: sizeErr, teamId, ...meta })
    return 'team_size'
  }
  const { data: composed, error: compositionErr } = await db
    .from('race_registrations')
    .update({ team_composition: teamCompositionFor(rows.map((m) => m?.is_member === true)) })
    .eq('id', registrationId)
    .select('id')
  if (compositionErr || !Array.isArray(composed) || composed.length === 0) {
    logError(MODULE, 'place: team composition update failed', { err: compositionErr, registrationId, ...meta })
    return 'team_composition'
  }
  return null
}

/**
 * Flip one solo to placed. Guarded on confirmed + looking_for_team so a
 * concurrent place (or a cancel) cannot be overwritten: zero rows is 'raced'.
 * @returns {Promise<'ok'|'error'|'raced'>}
 */
async function flipSolo(db, { soloId, intoId, byProfileId, at, meta }) {
  const { data, error } = await db
    .from('race_registrations')
    .update({ status: 'placed', placed_into_registration_id: intoId, placed_at: at, placed_by: byProfileId || null })
    .eq('id', soloId)
    .eq('status', 'confirmed')
    .eq('looking_for_team', true)
    .select('id')
  if (error) {
    logError(MODULE, 'solo status flip failed; the person is on the team AND still in the queue', { err: error, soloId, intoId, ...meta })
    return 'error'
  }
  if (!Array.isArray(data) || data.length !== 1) {
    logError(MODULE, 'solo status flip matched no row (placed or changed concurrently); the person may now be on two teams', { soloId, intoId, ...meta })
    return 'raced'
  }
  return 'ok'
}

/**
 * Place one solo entrant into an existing team entry on the same event. Their
 * wave is not changed: they join the team wherever it runs.
 *
 * @param {object} db  service-role client
 * @param {{ soloRegistrationId: string, teamRegistrationId: string, byProfileId?: string|null, now?: Date|string }} args
 * @returns {Promise<{ ok: true } | { ok: false, error: string, stage?: string }>}
 */
export async function placeSoloIntoTeam(db, { soloRegistrationId, teamRegistrationId, byProfileId = null, now = new Date() } = {}) {
  const meta = { soloRegistrationId, teamRegistrationId }
  const at = isoOf(now)

  const { data: solo, error: soloErr } = await db
    .from('race_registrations').select(SOLO_SELECT).eq('id', soloRegistrationId).maybeSingle()
  if (soloErr) {
    logError(MODULE, 'place: solo read failed', { err: soloErr, ...meta })
    return fail(PLACEMENT_ERRORS.LOAD_FAILED)
  }
  if (!solo) return fail(PLACEMENT_ERRORS.NOT_FOUND)
  const refused = soloRefusal(solo)
  if (refused) return fail(refused)

  const { data: target, error: targetErr } = await db
    .from('race_registrations').select(TARGET_SELECT).eq('id', teamRegistrationId).maybeSingle()
  if (targetErr) {
    logError(MODULE, 'place: target read failed', { err: targetErr, ...meta })
    return fail(PLACEMENT_ERRORS.LOAD_FAILED)
  }
  if (!target) return fail(PLACEMENT_ERRORS.NOT_FOUND)
  if (target.race_event_id !== solo.race_event_id) return fail(PLACEMENT_ERRORS.WRONG_EVENT)
  if (target.status !== 'confirmed' || target.looking_for_team || !target.team_id || !target.teams) {
    return fail(PLACEMENT_ERRORS.TARGET_NOT_LIVE)
  }
  const person = soloPerson(solo)
  if (!person) return fail(PLACEMENT_ERRORS.NO_MEMBER_ROW)

  // 1. The person joins the team. Its id is kept so a lost race (step 3) can
  // take back exactly this row.
  const { data: inserted, error: memberErr } = await db
    .from('team_members').insert(memberRowFor(target.team_id, solo, person, 'member')).select('id').single()
  if (memberErr || !inserted?.id) {
    logError(MODULE, 'place: team member insert failed; nothing changed', { err: memberErr, ...meta })
    return fail(PLACEMENT_ERRORS.WRITE_FAILED, { stage: 'member_insert' })
  }

  // 2. The team's size and its entry's composition, from a fresh members read.
  const syncFailed = await syncTeamFromMembers(db, { teamId: target.team_id, registrationId: target.id, meta })
  if (syncFailed) {
    logError(MODULE, 'place: the person is on the team AND still in the queue; size or composition may be stale', { stage: syncFailed, ...meta })
    return fail(PLACEMENT_ERRORS.WRITE_FAILED, { stage: syncFailed })
  }

  // 3. The solo row leaves the queue.
  const flip = await flipSolo(db, { soloId: solo.id, intoId: target.id, byProfileId, at, meta })
  if (flip === 'error') return fail(PLACEMENT_ERRORS.WRITE_FAILED, { stage: 'status_flip' })
  if (flip === 'raced') {
    // Someone else placed (or changed) the solo first: take back this call's
    // own member row and re-sync, so the race leaves no duplicate.
    const { data: removed, error: removeErr } = await db
      .from('team_members').delete().eq('id', inserted.id).select('id')
    if (removeErr || !Array.isArray(removed) || removed.length !== 1) {
      logError(MODULE, 'place: lost the race and could not remove the member row this call added; the person may be on the team twice', { err: removeErr, memberId: inserted.id, ...meta })
      return fail(PLACEMENT_ERRORS.WRITE_FAILED, { stage: 'rollback' })
    }
    const resynced = await syncTeamFromMembers(db, { teamId: target.team_id, registrationId: target.id, meta })
    if (resynced) {
      logError(MODULE, 'place: lost the race; member row removed but size or composition not re-synced', { stage: resynced, ...meta })
      return fail(PLACEMENT_ERRORS.WRITE_FAILED, { stage: 'rollback' })
    }
    return fail(PLACEMENT_ERRORS.ALREADY_PLACED)
  }
  return { ok: true }
}

/**
 * Pair two or more solo entrants on one event into a NEW team entry. The first
 * id is the captain. The wave is `waveId` when given (one of the event's), else
 * the solos' common wave. In teams capacity mode the new team takes a slot, so
 * the wave must have one unless `force`; in people mode the solos are already
 * counted as people, so nothing is checked.
 *
 * @param {object} db  service-role client
 * @param {{ raceEventId: string, registrationIds: string[], teamName: string, waveId?: string|null,
 *   force?: boolean, byProfileId?: string|null, now?: Date|string }} args
 * @returns {Promise<{ ok: true, registrationId: string, placedIds: string[] }
 *   | { ok: false, error: string, ids?: string[], stage?: string, spots_left?: number|null,
 *       registrationId?: string, placedIds?: string[] }>}
 */
export async function pairSolos(db, { raceEventId, registrationIds, teamName, waveId = null, force = false, byProfileId = null, now = new Date() } = {}) {
  const ids = [...new Set((Array.isArray(registrationIds) ? registrationIds : []).filter(Boolean))]
  if (ids.length < 2) return fail(PLACEMENT_ERRORS.TOO_FEW)
  const meta = { raceEventId, registrationIds: ids }
  const at = isoOf(now)
  const name = String(teamName ?? '').trim()

  const { data: event, error: eventErr } = await db
    .from('race_events').select('id, location_id, capacity_mode').eq('id', raceEventId).maybeSingle()
  if (eventErr) {
    logError(MODULE, 'pair: event read failed', { err: eventErr, ...meta })
    return fail(PLACEMENT_ERRORS.LOAD_FAILED)
  }
  if (!event) return fail(PLACEMENT_ERRORS.NOT_FOUND)

  const { data: rows, error: rowsErr } = await db
    .from('race_registrations').select(SOLO_SELECT).in('id', ids)
  if (rowsErr) {
    logError(MODULE, 'pair: solo read failed', { err: rowsErr, ...meta })
    return fail(PLACEMENT_ERRORS.LOAD_FAILED)
  }
  const byId = new Map((rows || []).map((r) => [r.id, r]))
  const missing = ids.filter((id) => byId.get(id)?.race_event_id !== raceEventId)
  if (missing.length) return fail(PLACEMENT_ERRORS.NOT_FOUND, { ids: missing })
  const solos = ids.map((id) => byId.get(id))
  for (const s of solos) {
    const refused = soloRefusal(s)
    if (refused) return fail(refused, { ids: [s.id] })
  }
  const people = solos.map(soloPerson)
  const nobody = solos.filter((_, i) => !people[i]).map((s) => s.id)
  if (nobody.length) return fail(PLACEMENT_ERRORS.NO_MEMBER_ROW, { ids: nobody })

  // The wave.
  const { data: waves, error: wavesErr } = await db
    .from('race_waves').select('id, capacity').eq('race_event_id', raceEventId)
  if (wavesErr) {
    logError(MODULE, 'pair: wave read failed', { err: wavesErr, ...meta })
    return fail(PLACEMENT_ERRORS.LOAD_FAILED)
  }
  let waveIdToUse
  if (waveId) {
    waveIdToUse = waveId
  } else {
    const common = new Set(solos.map((s) => s.wave_id ?? null))
    if (common.size > 1) return fail(PLACEMENT_ERRORS.MIXED_WAVES)
    waveIdToUse = [...common][0]
  }
  const wave = waveIdToUse ? (waves || []).find((w) => w.id === waveIdToUse) || null : null
  if (waveIdToUse && !wave) return fail(PLACEMENT_ERRORS.INVALID_WAVE)

  // Teams mode: the new team takes one slot in the wave.
  if (wave && (event.capacity_mode || 'teams') !== 'people' && !force) {
    const { data: inWave, error: loadErr } = await db
      .from('race_registrations')
      .select(WAVE_LOAD_SELECT)
      .eq('race_event_id', raceEventId)
      .eq('wave_id', wave.id)
      .eq('status', 'confirmed')
    if (loadErr) {
      logError(MODULE, 'pair: wave load read failed', { err: loadErr, waveId: wave.id, ...meta })
      return fail(PLACEMENT_ERRORS.LOAD_FAILED)
    }
    if (!wouldFit(wave.capacity, inWave || [], 'teams')) {
      return fail(PLACEMENT_ERRORS.WAVE_FULL, { spots_left: spotsLeft(wave.capacity, inWave || [], 'teams') })
    }
  }

  // 1. The team. teams is UNIQUE (location_id, name): one retry with " (2)".
  const insertTeam = (teamNameToUse) => db
    .from('teams')
    .insert({ location_id: event.location_id, name: teamNameToUse, size: solos.length, captain_contact_id: solos[0].contact_id || people[0].contact_id || null })
    .select('id')
    .single()
  let { data: team, error: teamErr } = await insertTeam(name)
  if (teamErr?.code === '23505') ({ data: team, error: teamErr } = await insertTeam(`${name} (2)`))
  if (teamErr?.code === '23505') return fail(PLACEMENT_ERRORS.TEAM_NAME_TAKEN)
  if (teamErr || !team?.id) {
    logError(MODULE, 'pair: team insert failed; nothing changed', { err: teamErr, ...meta })
    return fail(PLACEMENT_ERRORS.WRITE_FAILED, { stage: 'team_insert' })
  }

  // 2. Its members, the first solo as captain.
  const memberRows = solos.map((s, i) => memberRowFor(team.id, s, people[i], i === 0 ? 'captain' : 'member'))
  const { error: membersErr } = await db.from('team_members').insert(memberRows)
  if (membersErr) {
    logError(MODULE, 'pair: team member insert failed; an empty team row was left behind, the solos are untouched', { err: membersErr, teamId: team.id, ...meta })
    return fail(PLACEMENT_ERRORS.WRITE_FAILED, { stage: 'members_insert' })
  }

  // 3. The team's registration.
  const { data: reg, error: regErr } = await db
    .from('race_registrations')
    .insert({
      race_event_id: raceEventId,
      team_id: team.id,
      contact_id: solos[0].contact_id || null,
      status: 'confirmed',
      wave_id: wave?.id ?? null,
      team_composition: teamCompositionFor(people.map((p) => p.is_member === true)),
      // The first solo's own answer to the register form's checkbox (mig 588).
      // host-contact-list grants HOST marketing consent off this column, so it
      // is carried, never invented: null grants nothing.
      marketing_consent: solos[0].marketing_consent ?? null,
      looking_for_team: false,
    })
    .select('id')
    .single()
  if (regErr || !reg?.id) {
    logError(MODULE, 'pair: team registration insert failed; a team with its members but no entry was left behind, the solos are untouched', { err: regErr, teamId: team.id, ...meta })
    return fail(PLACEMENT_ERRORS.WRITE_FAILED, { stage: 'registration_insert' })
  }

  // 4. Every solo leaves the queue. Attempt them all, then judge.
  const placedIds = []
  const failedIds = []
  for (const s of solos) {
    const flip = await flipSolo(db, { soloId: s.id, intoId: reg.id, byProfileId, at, meta })
    if (flip === 'ok') placedIds.push(s.id)
    else failedIds.push(s.id)
  }
  if (failedIds.length) {
    logError(MODULE, 'pair: some solos did not flip to placed; they are on the new team AND still in the queue', { registrationId: reg.id, failedIds, placedIds, ...meta })
    return fail(PLACEMENT_ERRORS.WRITE_FAILED, { stage: 'status_flip', registrationId: reg.id, ids: failedIds, placedIds })
  }
  return { ok: true, registrationId: reg.id, placedIds }
}
