// EVENTTEAM.1 + TEAMNAMES.1 — resolveEventTeam: a typed name never takes over
// a team row, and a team name is unique per event, not per studio.
import { describe, it, expect } from 'vitest'
import { fakeDb, eqOf } from '@/lib/event-waitlist.test-helpers'
import { resolveEventTeam } from './event-team.js'

const ARGS = { locationId: 'L1', raceEventId: 'e1', name: 'Rockets', size: 2, captainContactId: 'c1' }

const isLegacy = (q) => q.ops.some((o) => o[0] === 'is' && o[1] === 'race_event_id' && o[2] === null)

// eventTeams: name -> { id, captain_contact_id } at THIS event (e1).
// legacyTeams: name -> row with race_event_id NULL; legacyHere: legacy ids entered at e1.
// The fake answers only what the query asks: an event read must name e1.
function teamDb({ eventTeams = {}, legacyTeams = {}, legacyHere = new Set(), failRead = false, failLegacy = false, failHere = false, insertErr = null } = {}) {
  let n = 0
  return fakeDb((q) => {
    if (q.table === 'teams' && q.action === 'select') {
      if (isLegacy(q)) {
        if (failLegacy) return { data: null, error: { message: 'down' } }
        return { data: legacyTeams[eqOf(q, 'name')] || null, error: null }
      }
      if (failRead) return { data: null, error: { message: 'down' } }
      if (eqOf(q, 'race_event_id') !== 'e1') return { data: null, error: { message: 'unscoped read' } }
      return { data: eventTeams[eqOf(q, 'name')] || null, error: null }
    }
    if (q.table === 'teams' && q.action === 'insert') {
      if (insertErr) return { data: null, error: insertErr }
      if (eventTeams[q.payload.name]) return { data: null, error: { code: '23505', message: 'duplicate' } }
      return { data: { id: `t-new-${++n}` }, error: null }
    }
    if (q.table === 'race_registrations') {
      if (failHere) return { data: null, error: { message: 'down' } }
      const here = eqOf(q, 'race_event_id') === 'e1' && legacyHere.has(eqOf(q, 'team_id'))
      return { data: here ? [{ id: 'r-here' }] : [], error: null }
    }
    return { data: null, error: null }
  })
}
const writesTo = (db, id) => db.queries.filter((q) => q.table === 'teams' && (q.action === 'update' || q.action === 'delete') && eqOf(q, 'id') === id)

describe('resolveEventTeam', () => {
  it('creates the team at this event under the typed name when it is free', async () => {
    const db = teamDb()
    const r = await resolveEventTeam(db, ARGS)
    expect(r).toEqual({ ok: true, teamId: 't-new-1', teamName: 'Rockets', reused: false })
    expect(db.queries.find((q) => q.action === 'insert').payload)
      .toEqual({ location_id: 'L1', race_event_id: 'e1', name: 'Rockets', size: 2, captain_contact_id: 'c1' })
  })

  it("TEAMNAMES.1 — a returning captain keeps their name: their team at another event does not take it", async () => {
    // The captain's "Rockets" from an earlier event is an event row of THAT
    // event, invisible to this event's read; a legacy row entered elsewhere
    // (not here) does not hold the name either.
    const db = teamDb({ legacyTeams: { Rockets: { id: 't-old', captain_contact_id: 'c1' } } })
    const r = await resolveEventTeam(db, ARGS)
    expect(r).toEqual({ ok: true, teamId: 't-new-1', teamName: 'Rockets', reused: false })
    expect(writesTo(db, 't-old')).toHaveLength(0)
  })

  it("reuses the captain's own team at this event, and writes nothing to it", async () => {
    const db = teamDb({ eventTeams: { Rockets: { id: 't1', captain_contact_id: 'c1' } } })
    const r = await resolveEventTeam(db, ARGS)
    expect(r).toEqual({ ok: true, teamId: 't1', teamName: 'Rockets', reused: true })
    expect(writesTo(db, 't1')).toHaveLength(0)
    expect(db.queries.some((q) => q.action === 'insert')).toBe(false)
  })

  it("two teams never share a name at one event: another captain's gets the next free name", async () => {
    const db = teamDb({ eventTeams: { Rockets: { id: 't1', captain_contact_id: 'c-other' } } })
    const r = await resolveEventTeam(db, ARGS)
    expect(r).toEqual({ ok: true, teamId: 't-new-1', teamName: 'Rockets 2', reused: false })
    expect(writesTo(db, 't1')).toHaveLength(0)
  })

  it('a legacy event-less team entered at this event holds its name here', async () => {
    const other = teamDb({ legacyTeams: { Rockets: { id: 't-old', captain_contact_id: 'c-other' } }, legacyHere: new Set(['t-old']) })
    expect(await resolveEventTeam(other, ARGS)).toMatchObject({ ok: true, teamName: 'Rockets 2', reused: false })
    const own = teamDb({ legacyTeams: { Rockets: { id: 't-old', captain_contact_id: 'c1' } }, legacyHere: new Set(['t-old']) })
    expect(await resolveEventTeam(own, ARGS)).toEqual({ ok: true, teamId: 't-old', teamName: 'Rockets', reused: true })
  })

  it('a team with no captain on record, or a caller with no contact, is never reused', async () => {
    const noCaptain = teamDb({ eventTeams: { Rockets: { id: 't1', captain_contact_id: null } } })
    expect((await resolveEventTeam(noCaptain, { ...ARGS, captainContactId: null })).teamName).toBe('Rockets 2')
  })

  it('skips taken suffixes and reuses an own suffixed team', async () => {
    const db = teamDb({ eventTeams: {
      Rockets: { id: 't1', captain_contact_id: 'c-other' },
      'Rockets 2': { id: 't2', captain_contact_id: 'c-third' },
      'Rockets 3': { id: 't3', captain_contact_id: 'c1' },
    } })
    expect(await resolveEventTeam(db, ARGS)).toEqual({ ok: true, teamId: 't3', teamName: 'Rockets 3', reused: true })
  })

  it('a failed read refuses rather than guessing', async () => {
    expect(await resolveEventTeam(teamDb({ failRead: true }), ARGS)).toMatchObject({ ok: false, reason: 'read_failed' })
    expect(await resolveEventTeam(teamDb({ failLegacy: true }), ARGS)).toMatchObject({ ok: false, reason: 'read_failed' })
    const db = teamDb({ legacyTeams: { Rockets: { id: 't-old', captain_contact_id: 'c1' } }, failHere: true })
    expect(await resolveEventTeam(db, ARGS)).toMatchObject({ ok: false, reason: 'read_failed' })
  })

  it('an insert error other than a name clash is reported', async () => {
    expect(await resolveEventTeam(teamDb({ insertErr: { code: '42501', message: 'nope' } }), ARGS))
      .toMatchObject({ ok: false, reason: 'insert_failed', message: 'nope' })
  })

  it('gives up after the last suffix', async () => {
    const eventTeams = { Rockets: { id: 't1', captain_contact_id: 'x' }, 'Rockets 2': { id: 't2', captain_contact_id: 'x' } }
    expect(await resolveEventTeam(teamDb({ eventTeams }), { ...ARGS, maxTries: 2 })).toEqual({ ok: false, reason: 'no_free_name' })
  })
})
