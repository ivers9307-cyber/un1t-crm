// FINDTEAM.5 — placeSoloIntoTeam and pairSolos against a fake db that records
// every query (table, chained ops, write payload) in call order.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
const { logError } = await import('./log')
const { placeSoloIntoTeam, pairSolos, teamCompositionFor, PLACEMENT_ERRORS, PLACEMENT_ERROR_MESSAGES } = await import('./registration-placement.js')

const NOW = new Date('2026-10-24T10:00:00.000Z')
const AT = NOW.toISOString()

/**
 * A fake service-role client. `answer(q)` decides each response from the
 * recorded query { table, ops, write, payload }; every query lands on `log`.
 */
function fakeDb(answer) {
  const log = []
  return {
    log,
    from(table) {
      const q = { table, ops: [], write: null, payload: null }
      log.push(q)
      const b = {}
      for (const n of ['select', 'eq', 'in', 'is', 'order', 'limit', 'neq']) b[n] = (...a) => { q.ops.push([n, ...a]); return b }
      for (const n of ['insert', 'update', 'delete', 'upsert']) b[n] = (p) => { q.ops.push([n, p]); q.write = n; q.payload = p; return b }
      const settle = () => Promise.resolve(answer(q))
      b.maybeSingle = () => settle()
      b.single = () => settle()
      b.then = (res, rej) => settle().then(res, rej)
      return b
    },
  }
}
const eqOf = (q, col) => q.ops.find((o) => o[0] === 'eq' && o[1] === col)?.[2]
const writes = (db) => db.log.filter((q) => q.write)
const selectOf = (q) => q.ops.find((o) => o[0] === 'select')?.[1] || ''

const captain = (over = {}) => ({
  id: 'm-solo', contact_id: 'c-solo', name: 'Sarah Byrne', email: 'sarah@x.ie', role: 'captain',
  is_member: true, member_validation_status: 'verified', member_contact_id: 'c-solo', member_validated_at: '2026-10-20T09:00:00Z', ...over,
})
const soloRow = (over = {}) => ({
  id: 'r-solo', race_event_id: 'e1', team_id: 't-solo', contact_id: 'c-solo', status: 'confirmed', wave_id: 'w1',
  looking_for_team: true, placed_into_registration_id: null,
  teams: { id: 't-solo', team_members: [captain()] }, ...over,
})
const targetRow = (over = {}) => ({
  id: 'r-team', race_event_id: 'e1', team_id: 't-team', status: 'confirmed', looking_for_team: false,
  teams: { id: 't-team', size: 3 }, ...over,
})

function placeDb({ solo = soloRow(), target = targetRow(), soloErr = null, targetErr = null, memberErr = null, sizeRows = [{ id: 't-team' }], sizeErr = null, flipRows = [{ id: 'r-solo' }], flipErr = null } = {}) {
  return fakeDb((q) => {
    if (q.table === 'race_registrations' && !q.write) {
      const id = eqOf(q, 'id')
      if (id === 'r-solo') return { data: soloErr ? null : solo, error: soloErr }
      if (id === 'r-team') return { data: targetErr ? null : target, error: targetErr }
      return { data: null, error: null }
    }
    if (q.table === 'team_members' && q.write === 'insert') return { data: null, error: memberErr }
    if (q.table === 'teams' && q.write === 'update') return { data: sizeErr ? null : sizeRows, error: sizeErr }
    if (q.table === 'race_registrations' && q.write === 'update') return { data: flipErr ? null : flipRows, error: flipErr }
    return { data: null, error: null }
  })
}
const place = (db, over = {}) => placeSoloIntoTeam(db, { soloRegistrationId: 'r-solo', teamRegistrationId: 'r-team', byProfileId: 'p-staff', now: NOW, ...over })

beforeEach(() => { logError.mockClear() })

describe('PLACEMENT_ERRORS', () => {
  it('has plain-English copy for every code', () => {
    for (const code of Object.values(PLACEMENT_ERRORS)) expect(PLACEMENT_ERROR_MESSAGES[code], code).toMatch(/\S/)
  })
})

describe('placeSoloIntoTeam — happy path', () => {
  it('copies the solo onto the target team as a member, bumps size, then flips the solo to placed', async () => {
    const db = placeDb()
    expect(await place(db)).toEqual({ ok: true })
    const w = writes(db)
    expect(w.map((q) => `${q.table}.${q.write}`)).toEqual(['team_members.insert', 'teams.update', 'race_registrations.update'])
    expect(w[0].payload).toEqual({
      team_id: 't-team', contact_id: 'c-solo', name: 'Sarah Byrne', email: 'sarah@x.ie', role: 'member',
      is_member: true, member_validation_status: 'verified', member_contact_id: 'c-solo', member_validated_at: '2026-10-20T09:00:00Z',
    })
    expect(w[1].payload).toEqual({ size: 4 })
    expect(eqOf(w[1], 'id')).toBe('t-team')
    expect(w[2].payload).toEqual({ status: 'placed', placed_into_registration_id: 'r-team', placed_at: AT, placed_by: 'p-staff' })
  })
  it('guards the flip on confirmed + looking_for_team and reads the rows back', async () => {
    const db = placeDb()
    await place(db)
    const flip = writes(db)[2]
    expect(eqOf(flip, 'id')).toBe('r-solo')
    expect(eqOf(flip, 'status')).toBe('confirmed')
    expect(eqOf(flip, 'looking_for_team')).toBe(true)
    expect(flip.ops.some((o) => o[0] === 'select')).toBe(true)
  })
  it('never touches wave_id on either row (a team in another wave is a valid target)', async () => {
    const db = placeDb({ target: targetRow({ wave_id: 'w2' }) })
    expect((await place(db)).ok).toBe(true)
    for (const q of writes(db)) expect(q.payload).not.toHaveProperty('wave_id')
  })
  it('takes contact_id from the registration when the member row has none', async () => {
    const db = placeDb({ solo: soloRow({ teams: { id: 't-solo', team_members: [captain({ contact_id: null })] } }) })
    await place(db)
    expect(writes(db)[0].payload.contact_id).toBe('c-solo')
  })
  it('never reads race_events (the find_team switch does not gate placing)', async () => {
    const db = placeDb()
    await place(db)
    expect(db.log.some((q) => q.table === 'race_events')).toBe(false)
    expect(db.log.some((q) => /find_team/.test(selectOf(q)))).toBe(false)
  })
})

describe('placeSoloIntoTeam — refusals (nothing written)', () => {
  const refused = async (opts, code) => {
    const db = placeDb(opts)
    expect(await place(db)).toEqual({ ok: false, error: code })
    expect(writes(db)).toEqual([])
  }
  it('not_paid for a solo still pending_payment', () => refused({ solo: soloRow({ status: 'pending_payment' }) }, 'not_paid'))
  it('already_placed for a placed solo, with no second team_members row', () => refused({ solo: soloRow({ status: 'placed', placed_into_registration_id: 'r-x' }) }, 'already_placed'))
  it('not_solo for a cancelled solo', () => refused({ solo: soloRow({ status: 'cancelled' }) }, 'not_solo'))
  it('not_solo for a registration that is not looking for a team', () => refused({ solo: soloRow({ looking_for_team: false }) }, 'not_solo'))
  it('not_found for an unknown solo', () => refused({ solo: null }, 'not_found'))
  it('not_found for an unknown target', () => refused({ target: null }, 'not_found'))
  it('wrong_event for a target on another event', () => refused({ target: targetRow({ race_event_id: 'e2' }) }, 'wrong_event'))
  it('target_not_live for a target that is not confirmed', () => refused({ target: targetRow({ status: 'pending_payment' }) }, 'target_not_live'))
  it('target_not_live for a target that is itself a solo', () => refused({ target: targetRow({ looking_for_team: true }) }, 'target_not_live'))
  it('no_member_row for a solo whose team has nobody on it', () => refused({ solo: soloRow({ teams: { id: 't-solo', team_members: [] } }) }, 'no_member_row'))
  it('load_failed (logged) when the solo read fails', async () => {
    await refused({ soloErr: { message: 'boom' } }, 'load_failed')
    expect(logError).toHaveBeenCalled()
  })
  it('load_failed when the target read fails', () => refused({ targetErr: { message: 'boom' } }, 'load_failed'))
})

describe('placeSoloIntoTeam — failed writes', () => {
  it('a failed member insert stops before the size or the flip', async () => {
    const db = placeDb({ memberErr: { message: 'boom' } })
    expect(await place(db)).toEqual({ ok: false, error: 'write_failed', stage: 'member_insert' })
    expect(writes(db).map((q) => q.table)).toEqual(['team_members'])
    expect(logError).toHaveBeenCalled()
  })
  it('a failed size bump leaves the solo in the queue (logged), never lost', async () => {
    const db = placeDb({ sizeErr: { message: 'boom' } })
    expect(await place(db)).toEqual({ ok: false, error: 'write_failed', stage: 'team_size' })
    expect(writes(db).map((q) => q.table)).toEqual(['team_members', 'teams'])
    expect(logError).toHaveBeenCalled()
  })
  it('a size bump that touched no row is a failure too', async () => {
    expect(await place(placeDb({ sizeRows: [] }))).toEqual({ ok: false, error: 'write_failed', stage: 'team_size' })
  })
  it('a failed flip is write_failed at status_flip', async () => {
    expect(await place(placeDb({ flipErr: { message: 'boom' } }))).toEqual({ ok: false, error: 'write_failed', stage: 'status_flip' })
    expect(logError).toHaveBeenCalled()
  })
  it('a flip that matched no row (a concurrent place) is already_placed, logged', async () => {
    expect(await place(placeDb({ flipRows: [] }))).toEqual({ ok: false, error: 'already_placed' })
    expect(logError).toHaveBeenCalled()
  })
})

// ── pairSolos ──────────────────────────────────────────────────────────────

const solo = (n, over = {}) => soloRow({
  id: `r${n}`, team_id: `t${n}`, contact_id: `c${n}`,
  teams: { id: `t${n}`, team_members: [captain({ id: `m${n}`, contact_id: `c${n}`, name: `Solo ${n}`, email: `s${n}@x.ie`, member_contact_id: null, ...(over.member || {}) })] },
  ...over.row,
})

function pairDb({
  event = { id: 'e1', location_id: 'L1', capacity_mode: 'teams' },
  eventErr = null,
  waves = [{ id: 'w1', capacity: 10 }, { id: 'w2', capacity: 10 }],
  solos = [solo(1), solo(2)],
  solosErr = null,
  waveRows = [],
  teamAnswers = [{ data: { id: 't-new' }, error: null }],
  membersErr = null,
  regAnswer = { data: { id: 'r-new' }, error: null },
  flip = () => ({ data: [{ id: 'x' }], error: null }),
} = {}) {
  let teamCall = 0
  return fakeDb((q) => {
    if (q.table === 'race_events') return { data: eventErr ? null : event, error: eventErr }
    if (q.table === 'race_waves') return { data: waves, error: null }
    if (q.table === 'race_registrations' && !q.write) {
      if (q.ops.some((o) => o[0] === 'in')) return { data: solosErr ? null : solos, error: solosErr }
      return { data: waveRows, error: null }
    }
    if (q.table === 'teams' && q.write === 'insert') return teamAnswers[Math.min(teamCall++, teamAnswers.length - 1)]
    if (q.table === 'team_members' && q.write === 'insert') return { data: null, error: membersErr }
    if (q.table === 'race_registrations' && q.write === 'insert') return regAnswer
    if (q.table === 'race_registrations' && q.write === 'update') return flip(eqOf(q, 'id'))
    return { data: null, error: null }
  })
}
const pair = (db, over = {}) => pairSolos(db, { raceEventId: 'e1', registrationIds: ['r1', 'r2'], teamName: 'Team Solo', waveId: null, force: false, byProfileId: 'p-staff', now: NOW, ...over })

describe('pairSolos — happy path', () => {
  it('creates the team, its members, one confirmed registration, then flips each solo into it', async () => {
    const db = pairDb()
    expect(await pair(db)).toEqual({ ok: true, registrationId: 'r-new', placedIds: ['r1', 'r2'] })
    const w = writes(db)
    expect(w.map((q) => `${q.table}.${q.write}`)).toEqual([
      'teams.insert', 'team_members.insert', 'race_registrations.insert', 'race_registrations.update', 'race_registrations.update',
    ])
    expect(w[0].payload).toEqual({ location_id: 'L1', name: 'Team Solo', size: 2, captain_contact_id: 'c1' })
    expect(w[1].payload).toEqual([
      { team_id: 't-new', contact_id: 'c1', name: 'Solo 1', email: 's1@x.ie', role: 'captain', is_member: true, member_validation_status: 'verified', member_contact_id: null, member_validated_at: '2026-10-20T09:00:00Z' },
      { team_id: 't-new', contact_id: 'c2', name: 'Solo 2', email: 's2@x.ie', role: 'member', is_member: true, member_validation_status: 'verified', member_contact_id: null, member_validated_at: '2026-10-20T09:00:00Z' },
    ])
    expect(w[2].payload).toEqual({
      race_event_id: 'e1', team_id: 't-new', contact_id: 'c1', status: 'confirmed', wave_id: 'w1',
      team_composition: 'all_members', marketing_consent: true, looking_for_team: false,
    })
    expect(w[3].payload).toEqual({ status: 'placed', placed_into_registration_id: 'r-new', placed_at: AT, placed_by: 'p-staff' })
    expect([eqOf(w[3], 'id'), eqOf(w[4], 'id')]).toEqual(['r1', 'r2'])
    for (const f of [w[3], w[4]]) {
      expect(eqOf(f, 'status')).toBe('confirmed')
      expect(eqOf(f, 'looking_for_team')).toBe(true)
    }
  })
  it('keeps the caller\'s order (first id is the captain) and dedupes ids', async () => {
    const db = pairDb()
    await pair(db, { registrationIds: ['r2', 'r1', 'r2'] })
    const w = writes(db)
    expect(w[0].payload.captain_contact_id).toBe('c2')
    expect(w[1].payload.map((m) => [m.name, m.role])).toEqual([['Solo 2', 'captain'], ['Solo 1', 'member']])
    expect(w[0].payload.size).toBe(2)
  })
  it('never reads race_events.find_team', async () => {
    const db = pairDb()
    await pair(db)
    expect(db.log.some((q) => /find_team/.test(selectOf(q)))).toBe(false)
  })
})

describe('teamCompositionFor', () => {
  it('all_members / all_non_members / mixed', () => {
    expect(teamCompositionFor([true, true])).toBe('all_members')
    expect(teamCompositionFor([false, false])).toBe('all_non_members')
    expect(teamCompositionFor([true, false])).toBe('mixed')
  })
  it('pairSolos writes each composition from the solos\' member flags', async () => {
    for (const [flags, want] of [[[true, true], 'all_members'], [[false, false], 'all_non_members'], [[true, false], 'mixed']]) {
      const db = pairDb({ solos: [solo(1, { member: { is_member: flags[0] } }), solo(2, { member: { is_member: flags[1] } })] })
      await pair(db)
      expect(writes(db).find((q) => q.table === 'race_registrations' && q.write === 'insert').payload.team_composition).toBe(want)
    }
  })
})

describe('pairSolos — refusals (nothing written)', () => {
  const refused = async (dbOpts, over, want) => {
    const db = pairDb(dbOpts)
    expect(await pair(db, over)).toMatchObject(want)
    expect(writes(db)).toEqual([])
    return db
  }
  it('too_few with one id (after dedupe)', () => refused({}, { registrationIds: ['r1', 'r1'] }, { ok: false, error: 'too_few' }))
  it('not_found for an id that does not exist', () => refused({ solos: [solo(1)] }, {}, { ok: false, error: 'not_found', ids: ['r2'] }))
  it('not_found for an id on another event', () => refused({ solos: [solo(1), solo(2, { row: { race_event_id: 'e9' } })] }, {}, { ok: false, error: 'not_found', ids: ['r2'] }))
  it('not_found for an unknown event', () => refused({ event: null }, {}, { ok: false, error: 'not_found' }))
  it('already_placed for a placed solo, with no team_members insert', () => refused({ solos: [solo(1), solo(2, { row: { status: 'placed' } })] }, {}, { ok: false, error: 'already_placed', ids: ['r2'] }))
  it('not_solo for a cancelled solo', () => refused({ solos: [solo(1), solo(2, { row: { status: 'cancelled' } })] }, {}, { ok: false, error: 'not_solo', ids: ['r2'] }))
  it('not_paid for a pending_payment solo', () => refused({ solos: [solo(1, { row: { status: 'pending_payment' } }), solo(2)] }, {}, { ok: false, error: 'not_paid', ids: ['r1'] }))
  it('mixed_waves when the solos are in different waves and no wave is given', () => refused({ solos: [solo(1), solo(2, { row: { wave_id: 'w2' } })] }, {}, { ok: false, error: 'mixed_waves' }))
  it('invalid_wave for a wave that is not this event\'s', () => refused({}, { waveId: 'w-other' }, { ok: false, error: 'invalid_wave' }))
  it('load_failed when the solos read fails', () => refused({ solosErr: { message: 'boom' } }, {}, { ok: false, error: 'load_failed' }))
  it('load_failed when the event read fails', () => refused({ eventErr: { message: 'boom' } }, {}, { ok: false, error: 'load_failed' }))
})

describe('pairSolos — waves and capacity', () => {
  it('a given wave_id settles mixed waves, and the new registration carries it', async () => {
    const db = pairDb({ solos: [solo(1), solo(2, { row: { wave_id: 'w2' } })] })
    expect((await pair(db, { waveId: 'w2' })).ok).toBe(true)
    expect(writes(db).find((q) => q.table === 'race_registrations' && q.write === 'insert').payload.wave_id).toBe('w2')
  })
  const full = [{ id: 'a', status: 'confirmed', looking_for_team: false, team: { size: 2 } }, { id: 'b', status: 'confirmed', looking_for_team: false, team: { size: 2 } }]
  it('wave_full in teams mode when the wave has no team slot left', async () => {
    const db = pairDb({ waves: [{ id: 'w1', capacity: 2 }], waveRows: full })
    expect(await pair(db)).toEqual({ ok: false, error: 'wave_full', spots_left: 0 })
    expect(writes(db)).toEqual([])
    const count = db.log.find((q) => q.table === 'race_registrations' && !q.write && !q.ops.some((o) => o[0] === 'in'))
    expect(eqOf(count, 'wave_id')).toBe('w1')
    expect(eqOf(count, 'race_event_id')).toBe('e1')
    expect(selectOf(count)).toMatch(/looking_for_team/)
  })
  it('solos in the wave do not fill it: two solos and one team in a 2-team wave fit', async () => {
    const rows = [full[0], { id: 'r1', status: 'confirmed', looking_for_team: true, team: { size: 1 } }, { id: 'r2', status: 'confirmed', looking_for_team: true, team: { size: 1 } }]
    expect((await pair(pairDb({ waves: [{ id: 'w1', capacity: 2 }], waveRows: rows }))).ok).toBe(true)
  })
  it('force bypasses wave_full', async () => {
    const db = pairDb({ waves: [{ id: 'w1', capacity: 2 }], waveRows: full })
    expect((await pair(db, { force: true })).ok).toBe(true)
  })
  it('people mode does not count the wave (the solos are already counted as people)', async () => {
    const db = pairDb({ event: { id: 'e1', location_id: 'L1', capacity_mode: 'people' }, waves: [{ id: 'w1', capacity: 2 }], waveRows: full })
    expect((await pair(db)).ok).toBe(true)
    expect(db.log.filter((q) => q.table === 'race_registrations' && !q.write).length).toBe(1)
  })
})

describe('pairSolos — team name clash and failed writes', () => {
  const clash = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "teams_location_id_name_key"' } }
  it('retries once with " (2)" on a 23505 name clash', async () => {
    const db = pairDb({ teamAnswers: [clash, { data: { id: 't-new' }, error: null }] })
    expect((await pair(db)).ok).toBe(true)
    const inserts = writes(db).filter((q) => q.table === 'teams')
    expect(inserts.map((q) => q.payload.name)).toEqual(['Team Solo', 'Team Solo (2)'])
  })
  it('team_name_taken when the retry clashes too, nothing else written', async () => {
    const db = pairDb({ teamAnswers: [clash, clash] })
    expect(await pair(db)).toEqual({ ok: false, error: 'team_name_taken' })
    expect(writes(db).map((q) => q.table)).toEqual(['teams', 'teams'])
  })
  it('a non-clash team insert error is write_failed at team_insert', async () => {
    const db = pairDb({ teamAnswers: [{ data: null, error: { code: 'XX000', message: 'boom' } }] })
    expect(await pair(db)).toEqual({ ok: false, error: 'write_failed', stage: 'team_insert' })
    expect(writes(db).length).toBe(1)
  })
  it('a failed members insert stops before the registration', async () => {
    const db = pairDb({ membersErr: { message: 'boom' } })
    expect(await pair(db)).toEqual({ ok: false, error: 'write_failed', stage: 'members_insert' })
    expect(writes(db).map((q) => q.table)).toEqual(['teams', 'team_members'])
    expect(logError).toHaveBeenCalled()
  })
  it('a failed registration insert stops before any flip', async () => {
    const db = pairDb({ regAnswer: { data: null, error: { message: 'boom' } } })
    expect(await pair(db)).toEqual({ ok: false, error: 'write_failed', stage: 'registration_insert' })
    expect(writes(db).filter((q) => q.write === 'update')).toEqual([])
  })
  it('attempts every flip and reports the ones that did not land', async () => {
    const db = pairDb({
      solos: [solo(1), solo(2), solo(3)],
      flip: (id) => (id === 'r1' ? { data: null, error: { message: 'boom' } } : id === 'r2' ? { data: [], error: null } : { data: [{ id }], error: null }),
    })
    expect(await pair(db, { registrationIds: ['r1', 'r2', 'r3'] })).toEqual({
      ok: false, error: 'write_failed', stage: 'status_flip', registrationId: 'r-new', ids: ['r1', 'r2'], placedIds: ['r3'],
    })
    expect(writes(db).filter((q) => q.write === 'update').map((q) => eqOf(q, 'id'))).toEqual(['r1', 'r2', 'r3'])
    expect(logError).toHaveBeenCalled()
  })
})
