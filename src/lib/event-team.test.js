// EVENTTEAM.1 — resolveEventTeam: a typed name never takes over a team row.
import { describe, it, expect } from 'vitest'
import { fakeDb, eqOf } from '@/lib/event-waitlist.test-helpers'
import { resolveEventTeam } from './event-team.js'

const ARGS = { locationId: 'L1', raceEventId: 'e1', name: 'Rockets', size: 2, captainContactId: 'c1' }

// teams: name -> { id, captain_contact_id }; elsewhere: team ids entered at another event.
function teamDb({ teams = {}, elsewhere = new Set(), failRead = false, failElsewhere = false, insertErr = null } = {}) {
  let n = 0
  return fakeDb((q) => {
    if (q.table === 'teams' && q.action === 'select') {
      if (failRead) return { data: null, error: { message: 'down' } }
      return { data: teams[eqOf(q, 'name')] || null, error: null }
    }
    if (q.table === 'teams' && q.action === 'insert') {
      if (insertErr) return { data: null, error: insertErr }
      if (teams[q.payload.name]) return { data: null, error: { code: '23505', message: 'duplicate' } }
      return { data: { id: `t-new-${++n}` }, error: null }
    }
    if (q.table === 'race_registrations') {
      if (failElsewhere) return { data: null, error: { message: 'down' } }
      return { data: elsewhere.has(eqOf(q, 'team_id')) ? [{ id: 'r-other' }] : [], error: null }
    }
    return { data: null, error: null }
  })
}
const writesTo = (db, id) => db.queries.filter((q) => q.table === 'teams' && (q.action === 'update' || q.action === 'delete') && eqOf(q, 'id') === id)

describe('resolveEventTeam', () => {
  it('creates the team under the typed name when it is free', async () => {
    const db = teamDb()
    const r = await resolveEventTeam(db, ARGS)
    expect(r).toEqual({ ok: true, teamId: 't-new-1', teamName: 'Rockets', reused: false })
    expect(db.queries.find((q) => q.action === 'insert').payload).toEqual({ location_id: 'L1', name: 'Rockets', size: 2, captain_contact_id: 'c1' })
  })

  it("reuses the captain's own team with no entry at another event, and writes nothing to it", async () => {
    const db = teamDb({ teams: { Rockets: { id: 't1', captain_contact_id: 'c1' } } })
    const r = await resolveEventTeam(db, ARGS)
    expect(r).toEqual({ ok: true, teamId: 't1', teamName: 'Rockets', reused: true })
    expect(writesTo(db, 't1')).toHaveLength(0)
    const other = db.queries.find((q) => q.table === 'race_registrations')
    expect(other.ops).toContainEqual(['neq', 'race_event_id', 'e1'])
  })

  it("never takes over another captain's team: a fresh row under the next free name", async () => {
    const db = teamDb({ teams: { Rockets: { id: 't1', captain_contact_id: 'c-other' } } })
    const r = await resolveEventTeam(db, ARGS)
    expect(r).toEqual({ ok: true, teamId: 't-new-1', teamName: 'Rockets 2', reused: false })
    expect(writesTo(db, 't1')).toHaveLength(0)
  })

  it('a team with no captain on record, or a caller with no contact, is never reused', async () => {
    const noCaptain = teamDb({ teams: { Rockets: { id: 't1', captain_contact_id: null } } })
    expect((await resolveEventTeam(noCaptain, { ...ARGS, captainContactId: null })).teamName).toBe('Rockets 2')
  })

  it("the captain's own team entered at another event gets a fresh row, so that event's roster is untouched", async () => {
    const db = teamDb({ teams: { Rockets: { id: 't1', captain_contact_id: 'c1' } }, elsewhere: new Set(['t1']) })
    const r = await resolveEventTeam(db, ARGS)
    expect(r).toMatchObject({ ok: true, teamName: 'Rockets 2', reused: false })
    expect(writesTo(db, 't1')).toHaveLength(0)
  })

  it('skips taken suffixes and reuses an own suffixed team', async () => {
    const db = teamDb({ teams: {
      Rockets: { id: 't1', captain_contact_id: 'c-other' },
      'Rockets 2': { id: 't2', captain_contact_id: 'c-third' },
      'Rockets 3': { id: 't3', captain_contact_id: 'c1' },
    } })
    expect(await resolveEventTeam(db, ARGS)).toEqual({ ok: true, teamId: 't3', teamName: 'Rockets 3', reused: true })
  })

  it('a failed read refuses rather than guessing', async () => {
    expect(await resolveEventTeam(teamDb({ failRead: true }), ARGS)).toMatchObject({ ok: false, reason: 'read_failed' })
    const db = teamDb({ teams: { Rockets: { id: 't1', captain_contact_id: 'c1' } }, failElsewhere: true })
    expect(await resolveEventTeam(db, ARGS)).toMatchObject({ ok: false, reason: 'read_failed' })
  })

  it('an insert error other than a name clash is reported', async () => {
    expect(await resolveEventTeam(teamDb({ insertErr: { code: '42501', message: 'nope' } }), ARGS))
      .toMatchObject({ ok: false, reason: 'insert_failed', message: 'nope' })
  })

  it('gives up after the last suffix', async () => {
    const teams = { Rockets: { id: 't1', captain_contact_id: 'x' }, 'Rockets 2': { id: 't2', captain_contact_id: 'x' } }
    expect(await resolveEventTeam(teamDb({ teams }), { ...ARGS, maxTries: 2 })).toEqual({ ok: false, reason: 'no_free_name' })
  })
})
