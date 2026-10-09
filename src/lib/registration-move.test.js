import { describe, it, expect, vi } from 'vitest'
import {
  entryLabel, entryHeadcount, computePriceGapCents, evaluateMove, MOVE_ERRORS, MOVE_ERROR_MESSAGES,
  listMoveTargets, moveRegistration, readRegistrationForMove, entryLeadEmail, checkMove,
} from './registration-move.js'
import { entryLeadEmail as entryLeadEmailBrowserSafe } from './registration-entry.js'

// The moved email always fails here, which is the case the move must survive.
const sendMovedEmail = vi.hoisted(() => vi.fn(async () => { throw new Error('postmark down') }))
vi.mock('./race-confirmations', () => ({ sendRegistrationMovedEmail: sendMovedEmail }))
const syncHostList = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('./host-contact-list', () => ({ addEventAttendeesToHostList: syncHostList }))

describe('entryLabel', () => {
  it('names a team of two or more by the team name', () => {
    expect(entryLabel({ teams: { name: 'The Crushers', team_members: [{ name: 'A' }, { name: 'B' }] } })).toBe('The Crushers')
  })
  it('names a team of one by the person, not the team', () => {
    expect(entryLabel({ teams: { name: 'Mark Kelly', team_members: [{ name: 'Mark Kelly', role: 'captain' }] } })).toBe('Mark Kelly')
  })
  it('names a team-less entry by its lead contact', () => {
    expect(entryLabel({ teams: null, contact: { first_name: 'Aoife', last_name: 'Byrne' } })).toBe('Aoife Byrne')
  })
  it('falls back to "Entry" when nothing is known', () => {
    expect(entryLabel({})).toBe('Entry')
  })
})

describe('entryHeadcount', () => {
  it('counts the team members', () => {
    expect(entryHeadcount({ teams: { size: 4, team_members: [{}, {}] } })).toBe(2)
  })
  it('falls back to teams.size when members are not loaded', () => {
    expect(entryHeadcount({ teams: { size: 3 } })).toBe(3)
  })
  it('is 1 for a team-less entry', () => {
    expect(entryHeadcount({ teams: null })).toBe(1)
    expect(entryHeadcount({})).toBe(1)
  })
})

describe('computePriceGapCents', () => {
  const source = { member_pricing_enabled: true, member_fee_cents: 2000, non_member_fee_cents: 3000 }
  const target = { member_pricing_enabled: true, member_fee_cents: 2500, non_member_fee_cents: 3500 }
  it('charges the member rate for members and the non-member rate otherwise', () => {
    const members = [{ is_member: true }, { is_member: false }]
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: target, members })).toBe(500 + 500)
  })
  it('is negative when the target is cheaper', () => {
    expect(computePriceGapCents({ sourceEvent: target, targetEvent: source, members: [{ is_member: false }] })).toBe(-500)
  })
  it('uses the non-member rate for everyone when member pricing is off', () => {
    const t = { member_pricing_enabled: false, member_fee_cents: 0, non_member_fee_cents: 3500 }
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: t, members: [{ is_member: true }] })).toBe(1500)
  })
  it('treats a missing fee as free', () => {
    expect(computePriceGapCents({ sourceEvent: {}, targetEvent: target, members: [{ is_member: false }] })).toBe(3500)
  })
  it('counts one person for a team-less entry', () => {
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: target, members: [] })).toBe(500)
  })
  it('prices `headcount` non-members when no roster is loaded', () => {
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: target, members: [], headcount: 3 })).toBe(1500)
  })
  it('the roster wins over headcount when it is loaded', () => {
    expect(computePriceGapCents({ sourceEvent: source, targetEvent: target, members: [{ is_member: true }], headcount: 3 })).toBe(500)
  })
})

describe('MOVE_ERRORS', () => {
  it('carries load_failed, write_failed and conflict', () => {
    expect(MOVE_ERRORS.LOAD_FAILED).toBe('load_failed')
    expect(MOVE_ERRORS.WRITE_FAILED).toBe('write_failed')
    expect(MOVE_ERRORS.CONFLICT).toBe('conflict')
    expect(MOVE_ERROR_MESSAGES.conflict).toBe('This entry changed while you were moving it. Reload and try again.')
    expect(MOVE_ERROR_MESSAGES.checked_in).toBe('Someone on this entry has already checked in or raced, so it cannot move.')
  })
  it('has plain-English copy for every code', () => {
    for (const code of Object.values(MOVE_ERRORS)) expect(MOVE_ERROR_MESSAGES[code], code).toMatch(/\S/)
    expect(MOVE_ERROR_MESSAGES.load_failed).toBe('The entry could not be read. Try again.')
    expect(MOVE_ERROR_MESSAGES.write_failed).toBe('The move could not be saved. Nothing changed. Try again.')
  })
})

const TODAY = '2026-10-08'
function base(over = {}) {
  return {
    registration: { id: 'r1', status: 'confirmed', race_event_id: 'e1', wave_id: 'w1', team_id: 't1',
      teams: { id: 't1', name: 'The Crushers', size: 2, team_members: [{ is_member: false }, { is_member: false }] } },
    sourceEvent: { id: 'e1', host_id: null, location_id: 'L1', allowed_team_sizes: [1, 2, 4] },
    targetEvent: { id: 'e2', host_id: null, location_id: 'L1', active: true, status: 'published', race_date: '2026-10-25',
      capacity_mode: 'teams', allowed_team_sizes: [1, 2, 4], waves: [{ id: 'w9', capacity: 10 }] },
    targetWave: { id: 'w9', race_event_id: 'e2', capacity: 10 },
    targetWaveRegistrations: [],
    checkinCount: 0,
    existingOnTarget: null,
    force: false,
    today: TODAY,
    ...over,
  }
}

describe('evaluateMove', () => {
  it('passes a clean move', () => {
    expect(evaluateMove(base())).toEqual({ ok: true })
  })
  it('not_active for cancelled and no_show', () => {
    expect(evaluateMove(base({ registration: { ...base().registration, status: 'cancelled' } })).error).toBe(MOVE_ERRORS.NOT_ACTIVE)
    expect(evaluateMove(base({ registration: { ...base().registration, status: 'no_show' } })).error).toBe(MOVE_ERRORS.NOT_ACTIVE)
  })
  it('refuses an entry awaiting payment: its payment link is priced for the source event', () => {
    expect(evaluateMove(base({ registration: { ...base().registration, status: 'pending_payment' } }))).toEqual({ ok: false, error: MOVE_ERRORS.PENDING_PAYMENT })
  })
  it('force does not skip pending_payment', () => {
    expect(evaluateMove(base({ registration: { ...base().registration, status: 'pending_payment' }, force: true })).error).toBe(MOVE_ERRORS.PENDING_PAYMENT)
  })
  it('checked_in when anyone has checked in', () => {
    expect(evaluateMove(base({ checkinCount: 1 })).error).toBe(MOVE_ERRORS.CHECKED_IN)
  })
  it('checked_in when the entry has started or finished racing', () => {
    const reg = base().registration
    expect(evaluateMove(base({ registration: { ...reg, race_started_at: '2026-10-08T10:00:00Z' } })).error).toBe(MOVE_ERRORS.CHECKED_IN)
    expect(evaluateMove(base({ registration: { ...reg, race_finished_at: '2026-10-08T10:20:00Z' } })).error).toBe(MOVE_ERRORS.CHECKED_IN)
  })
  it('same_event when the target is the source', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, id: 'e1' } })).error).toBe(MOVE_ERRORS.SAME_EVENT)
  })
  it('target_unavailable for draft, inactive or past events', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, status: 'draft' } })).error).toBe(MOVE_ERRORS.TARGET_UNAVAILABLE)
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, active: false } })).error).toBe(MOVE_ERRORS.TARGET_UNAVAILABLE)
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, race_date: '2026-10-07' } })).error).toBe(MOVE_ERRORS.TARGET_UNAVAILABLE)
  })
  it('a target on today is still available', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, race_date: TODAY } })).ok).toBe(true)
  })
  it('different_payee when host_id differs; NULL equals NULL', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, host_id: 'h1' } })).error).toBe(MOVE_ERRORS.DIFFERENT_PAYEE)
    expect(evaluateMove(base({ sourceEvent: { ...base().sourceEvent, host_id: 'h1' }, targetEvent: { ...base().targetEvent, host_id: 'h1' } })).ok).toBe(true)
  })
  it('allows a move to another studio', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, location_id: 'L2' } })).ok).toBe(true)
  })
  it('already_entered only at the same studio', () => {
    expect(evaluateMove(base({ existingOnTarget: { id: 'r7', status: 'confirmed' } })).error).toBe(MOVE_ERRORS.ALREADY_ENTERED)
    // UNIQUE (race_event_id, team_id) is not partial: a cancelled row of the
    // same team on the target would make the write fail, so refuse it here.
    expect(evaluateMove(base({ existingOnTarget: { id: 'r7', status: 'cancelled' } })).error).toBe(MOVE_ERRORS.ALREADY_ENTERED)
    expect(evaluateMove(base({ existingOnTarget: { id: 'r7', status: 'confirmed' }, targetEvent: { ...base().targetEvent, location_id: 'L2' } })).ok).toBe(true)
  })
  it('headcount_not_allowed when the target does not accept the size', () => {
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, allowed_team_sizes: [1, 4] } })).error).toBe(MOVE_ERRORS.HEADCOUNT_NOT_ALLOWED)
    expect(evaluateMove(base({ targetEvent: { ...base().targetEvent, allowed_team_sizes: null } })).ok).toBe(true)
  })
  it('wave_required when the target has waves and none was given', () => {
    expect(evaluateMove(base({ targetWave: null })).error).toBe(MOVE_ERRORS.WAVE_REQUIRED)
  })
  it('no wave needed when the target has no waves', () => {
    expect(evaluateMove(base({ targetWave: null, targetEvent: { ...base().targetEvent, waves: [] } })).ok).toBe(true)
  })
  it('wrong_event when the wave belongs elsewhere', () => {
    expect(evaluateMove(base({ targetWave: { id: 'w9', race_event_id: 'e3', capacity: 10 } })).error).toBe(MOVE_ERRORS.WRONG_EVENT)
  })
  it('wave_full in teams mode counts confirmed entries, with spots_left', () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, status: 'confirmed', team: { size: 1 } }))
    const r = evaluateMove(base({ targetWaveRegistrations: full }))
    expect(r.error).toBe(MOVE_ERRORS.WAVE_FULL)
    expect(r.spots_left).toBe(0)
  })
  it('wave_full in people mode needs room for the whole entry', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, status: 'confirmed', team: { size: 1 } }))
    const r = evaluateMove(base({ targetWaveRegistrations: nine, targetEvent: { ...base().targetEvent, capacity_mode: 'people' } }))
    expect(r.error).toBe(MOVE_ERRORS.WAVE_FULL)
    expect(r.spots_left).toBe(1)
  })
  it('force skips wave_full and nothing else', () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, status: 'confirmed', team: { size: 1 } }))
    expect(evaluateMove(base({ targetWaveRegistrations: full, force: true })).ok).toBe(true)
    expect(evaluateMove(base({ checkinCount: 1, force: true })).error).toBe(MOVE_ERRORS.CHECKED_IN)
  })
  it('an uncapped wave always fits', () => {
    expect(evaluateMove(base({ targetWave: { id: 'w9', race_event_id: 'e2', capacity: null } })).ok).toBe(true)
  })
})

// A recording fake db. Each `from(table)` returns a builder whose terminal
// (`maybeSingle`, `single`, or awaiting the chain) answers from `answers[table]`,
// which may be a function of the recorded ops.
function fakeDb(answers, { rpc } = {}) {
  const calls = []
  return {
    calls,
    rpc: rpc || vi.fn(async () => ({ data: null, error: null })),
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const answer = () => {
        const a = answers[table]
        const v = typeof a === 'function' ? a(q) : a
        return Promise.resolve(v ?? { data: null, error: null })
      }
      const b = {}
      for (const name of ['select', 'eq', 'neq', 'in', 'gte', 'order', 'limit', 'range', 'is', 'update', 'insert', 'not']) {
        b[name] = (...args) => { q.ops.push([name, ...args]); return b }
      }
      b.maybeSingle = () => answer()
      b.single = () => answer()
      b.then = (res, rej) => answer().then(res, rej)
      return b
    },
  }
}

const REG = {
  id: 'r1', status: 'confirmed', race_event_id: 'e1', wave_id: 'w1', team_id: 't1', contact_id: 'c1',
  contact: { id: 'c1', first_name: 'Aoife', last_name: 'Byrne', email: 'lead@example.test' },
  teams: { id: 't1', name: 'The Crushers', size: 2, team_members: [{ id: 'm1', name: 'Aoife', role: 'captain', is_member: true, email: 'captain@example.test' }, { id: 'm2', name: 'Dan', role: 'member', is_member: false, email: 'dan@example.test' }] },
  race: { id: 'e1', name: 'Hatch Oct 18', race_date: '2026-10-18', location_id: 'L1', host_id: null, member_pricing_enabled: true, member_fee_cents: 2000, non_member_fee_cents: 3000 },
}
const TARGET = { id: 'e2', name: 'Hatch Oct 25', race_date: '2026-10-25', location_id: 'L1', host_id: null, active: true, status: 'published',
  capacity_mode: 'teams', allowed_team_sizes: [1, 2, 4], member_pricing_enabled: true, member_fee_cents: 2500, non_member_fee_cents: 3500,
  waves: [{ id: 'w9', race_event_id: 'e2', start_time: '11:00:00', label: null, capacity: 10 }], locations: { id: 'L1', name: 'Hatch St' } }

describe('listMoveTargets', () => {
  it('lists same-payee, published, upcoming events at allowed studios with spots and the price gap', async () => {
    const db = fakeDb({
      race_registrations: (q) => (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id') ? { data: REG } : { data: [] }),
      race_events: { data: [TARGET, { ...TARGET, id: 'e3', host_id: 'h1' }, { ...TARGET, id: 'e4', location_id: 'L9', locations: { id: 'L9', name: 'Elsewhere' } }] },
    })
    const r = await listMoveTargets(db, { registrationId: 'r1', allowedLocationIds: ['L1'], today: '2026-10-08' })
    expect(r.ok).toBe(true)
    expect(r.targets.map((t) => t.id)).toEqual(['e2'])
    expect(r.targets[0].price_gap_cents).toBe(1000)
    expect(r.targets[0].waves[0].spots_left).toBe(10)
    expect(r.entry).toMatchObject({ id: 'r1', label: 'The Crushers', headcount: 2 })
  })
  it('null allowedLocationIds means every studio', async () => {
    const db = fakeDb({
      race_registrations: (q) => (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id') ? { data: REG } : { data: [] }),
      race_events: { data: [TARGET, { ...TARGET, id: 'e4', location_id: 'L9', locations: { id: 'L9', name: 'Elsewhere' } }] },
    })
    const r = await listMoveTargets(db, { registrationId: 'r1', allowedLocationIds: null, today: '2026-10-08' })
    expect(r.targets.map((t) => t.id)).toEqual(['e2', 'e4'])
    const q = db.calls.find((c) => c.table === 'race_events')
    expect(q.ops.some((o) => o[0] === 'in' && o[1] === 'location_id')).toBe(false)
  })
  it('filters payee and studio in the query, before the row cap', async () => {
    const db = fakeDb({
      race_registrations: (q) => (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id') ? { data: REG } : { data: [] }),
      race_events: { data: [TARGET] },
    })
    await listMoveTargets(db, { registrationId: 'r1', allowedLocationIds: ['L1'], today: '2026-10-08' })
    const ops = db.calls.find((c) => c.table === 'race_events').ops
    const at = (pred) => ops.findIndex(pred)
    const payee = at((o) => o[0] === 'is' && o[1] === 'host_id' && o[2] === null)
    const studio = at((o) => o[0] === 'in' && o[1] === 'location_id' && o[2].join() === 'L1')
    const cap = at((o) => o[0] === 'limit')
    expect(payee).toBeGreaterThanOrEqual(0)
    expect(studio).toBeGreaterThanOrEqual(0)
    expect(payee).toBeLessThan(cap)
    expect(studio).toBeLessThan(cap)
  })
  it('a hosted source filters the query on its host', async () => {
    const hosted = { ...REG, race: { ...REG.race, host_id: 'h1' } }
    const db = fakeDb({
      race_registrations: (q) => (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id') ? { data: hosted } : { data: [] }),
      race_events: { data: [TARGET, { ...TARGET, id: 'e3', host_id: 'h1' }] },
    })
    const r = await listMoveTargets(db, { registrationId: 'r1', today: '2026-10-08' })
    const ops = db.calls.find((c) => c.table === 'race_events').ops
    expect(ops).toContainEqual(['eq', 'host_id', 'h1'])
    expect(r.targets.map((t) => t.id)).toEqual(['e3']) // the JS belt still drops e2
  })
  it('not_found for an unknown entry', async () => {
    const r = await listMoveTargets(fakeDb({ race_registrations: { data: null } }), { registrationId: 'nope' })
    expect(r).toEqual({ ok: false, error: 'not_found' })
  })
  it('reads every wave of every eligible event in ONE query, grouped by wave', async () => {
    const twoWaves = { ...TARGET, waves: [...TARGET.waves, { id: 'w8', race_event_id: 'e2', start_time: '09:00:00', label: null, capacity: 5 }] }
    const other = { ...TARGET, id: 'e5', waves: [{ id: 'w7', race_event_id: 'e5', start_time: '10:00:00', label: null, capacity: 3 }] }
    const rows = [
      { id: 'a', status: 'confirmed', wave_id: 'w9', team: { size: 2 } },
      { id: 'b', status: 'confirmed', wave_id: 'w9', team: { size: 1 } },
      { id: 'c', status: 'confirmed', wave_id: 'w7', team: { size: 1 } },
      { id: 'd', status: 'pending_payment', wave_id: 'w8', team: { size: 1 } },
    ]
    const db = fakeDb({
      race_registrations: (q) => (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id') ? { data: REG } : { data: rows }),
      race_events: { data: [twoWaves, other] },
    })
    const r = await listMoveTargets(db, { registrationId: 'r1', today: '2026-10-08' })
    const spots = Object.fromEntries(r.targets.flatMap((t) => t.waves.map((w) => [w.id, w.spots_left])))
    expect(spots).toEqual({ w9: 8, w8: 5, w7: 2 }) // pending_payment does not take a spot
    const waveQueries = db.calls.filter((c) => c.table === 'race_registrations' && c.ops.some((o) => o[0] === 'in' && o[1] === 'wave_id'))
    expect(waveQueries).toHaveLength(1)
    expect(waveQueries[0].ops.find((o) => o[0] === 'in' && o[1] === 'wave_id')[2].sort()).toEqual(['w7', 'w8', 'w9'])
    expect(waveQueries[0].ops).toContainEqual(['order', 'id'])
  })
  it('pages the wave read 1000 rows at a time', async () => {
    const page = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `x${from + i}`, status: 'confirmed', wave_id: 'w9', team: { size: 1 } }))
    const db = fakeDb({
      race_registrations: (q) => {
        if (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id')) return { data: REG }
        const range = q.ops.find((o) => o[0] === 'range')
        return { data: range[1] === 0 ? page(0, 1000) : page(1000, 3) }
      },
      race_events: { data: [{ ...TARGET, waves: [{ ...TARGET.waves[0], capacity: 2000 }] }] },
    })
    const r = await listMoveTargets(db, { registrationId: 'r1', today: '2026-10-08' })
    expect(r.targets[0].waves[0].spots_left).toBe(2000 - 1003)
    const ranges = db.calls.filter((c) => c.ops.some((o) => o[0] === 'range')).map((c) => c.ops.find((o) => o[0] === 'range').slice(1))
    expect(ranges).toEqual([[0, 999], [1000, 1999]])
  })
  it('drops an event that does not accept the entry\'s headcount', async () => {
    const db = fakeDb({
      race_registrations: (q) => (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id') ? { data: REG } : { data: [] }),
      race_events: { data: [TARGET, { ...TARGET, id: 'e6', allowed_team_sizes: [1, 4] }, { ...TARGET, id: 'e7', allowed_team_sizes: null }] },
    })
    const r = await listMoveTargets(db, { registrationId: 'r1', today: '2026-10-08' })
    expect(r.targets.map((t) => t.id)).toEqual(['e2', 'e7'])
  })
  it('load_failed when the wave read fails, never a wave that looks empty', async () => {
    const db = fakeDb({
      race_registrations: (q) => (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id') ? { data: REG } : { data: null, error: { message: 'timeout' } }),
      race_events: { data: [TARGET] },
    })
    expect(await listMoveTargets(db, { registrationId: 'r1', today: '2026-10-08' })).toEqual({ ok: false, error: 'load_failed' })
  })
  it('load_failed when the entry cannot be read', async () => {
    const r = await listMoveTargets(fakeDb({ race_registrations: { data: null, error: { message: 'timeout' } } }), { registrationId: 'r1' })
    expect(r).toEqual({ ok: false, error: 'load_failed' })
  })
})

describe('readRegistrationForMove', () => {
  it('returns the row, null for no row, and the error for a failed read', async () => {
    expect(await readRegistrationForMove(fakeDb({ race_registrations: { data: REG } }), 'r1')).toEqual({ registration: REG, error: null })
    expect(await readRegistrationForMove(fakeDb({ race_registrations: { data: null } }), 'r1')).toEqual({ registration: null, error: null })
    const failed = await readRegistrationForMove(fakeDb({ race_registrations: { data: null, error: { message: 'timeout' } } }), 'r1')
    expect(failed.registration).toBeNull()
    expect(failed.error).toEqual({ message: 'timeout' })
  })
  it('embeds the lead contact', async () => {
    const db = fakeDb({ race_registrations: { data: REG } })
    await readRegistrationForMove(db, 'r1')
    const select = db.calls[0].ops.find((o) => o[0] === 'select')[1]
    expect(select).toMatch(/contact:contact_id\s*\(\s*id, first_name, last_name, email, location_id\s*\)/)
    expect(select).toMatch(/\brace_started_at\b/)
    expect(select).toMatch(/\brace_finished_at\b/)
  })
})

describe('moveRegistration', () => {
  function happyDb(over = {}) {
    const rpc = vi.fn(async () => ({ data: { id: 'mv1', registration_id: 'r1', to_event_id: 'e2', price_gap_cents: 1000 }, error: null }))
    const db = fakeDb({
      race_registrations: (q) => {
        if (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id')) return over.regAnswer ?? { data: over.reg ?? REG }
        if (q.ops.some((o) => o[0] === 'eq' && o[1] === 'team_id')) return over.existingAnswer ?? { data: over.existingOnTarget ?? null }
        return over.waveAnswer ?? { data: over.waveRegs ?? [] }
      },
      race_events: over.targetAnswer ?? { data: over.target ?? TARGET },
      race_checkins: over.checkinAnswer ?? { data: null, count: over.checkins ?? 0, error: null },
      ...over.answers,
    }, { rpc })
    return { db, rpc }
  }
  const actor = { type: 'staff', id: 'u1', name: 'Richard' }

  it('runs the rules, then the SQL function with the computed gap', async () => {
    const { db, rpc } = happyDb()
    const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false })
    expect(r.ok).toBe(true)
    expect(rpc).toHaveBeenCalledWith('move_race_registration', expect.objectContaining({
      p_registration_id: 'r1', p_from_event_id: 'e1', p_to_event_id: 'e2', p_to_wave_id: 'w9', p_headcount: 2, p_price_gap_cents: 1000,
      p_forced: false, p_actor_type: 'staff', p_actor_id: 'u1', p_actor_name: 'Richard',
    }))
  })
  it('refuses before writing when a rule fails', async () => {
    const { db, rpc } = happyDb({ checkins: 1 })
    const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor })
    expect(r).toMatchObject({ ok: false, error: 'checked_in' })
    expect(rpc).not.toHaveBeenCalled()
  })
  it('wave_full carries spots_left and force gets past it', async () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, status: 'confirmed', team: { size: 1 } }))
    const a = happyDb({ waveRegs: full })
    expect(await moveRegistration(a.db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor })).toMatchObject({ ok: false, error: 'wave_full', spots_left: 0 })
    const b = happyDb({ waveRegs: full })
    const r = await moveRegistration(b.db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, force: true, notify: false })
    expect(r.ok).toBe(true)
    expect(b.rpc.mock.calls[0][1].p_forced).toBe(true)
  })
  it('refuses a target outside allowedEventIds as not_found', async () => {
    const { db, rpc } = happyDb()
    const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, allowedEventIds: new Set(['e5']) })
    expect(r).toMatchObject({ ok: false, error: 'not_found' })
    expect(rpc).not.toHaveBeenCalled()
  })
  it('surfaces a function error without pretending success', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'duplicate key value violates unique constraint' } }))
    const { db } = happyDb()
    db.rpc = rpc
    const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('write_failed')
  })
  it('not_found when the entry has no row; load_failed when it cannot be read', async () => {
    const a = happyDb({ regAnswer: { data: null } })
    expect(await moveRegistration(a.db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor })).toEqual({ ok: false, error: 'not_found' })
    const b = happyDb({ regAnswer: { data: null, error: { message: 'timeout' } } })
    expect(await moveRegistration(b.db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor })).toEqual({ ok: false, error: 'load_failed' })
    expect(a.rpc).not.toHaveBeenCalled()
    expect(b.rpc).not.toHaveBeenCalled()
  })
  it('load_failed when the check-in count fails (a real check-in is still checked_in)', async () => {
    const { db, rpc } = happyDb({ checkinAnswer: { data: null, count: null, error: { message: 'timeout' } } })
    expect(await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor })).toEqual({ ok: false, error: 'load_failed' })
    expect(rpc).not.toHaveBeenCalled()
  })
  it('load_failed when the already-entered lookup fails (a real entry is still already_entered)', async () => {
    const { db, rpc } = happyDb({ existingAnswer: { data: null, error: { message: 'timeout' } } })
    expect(await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor })).toEqual({ ok: false, error: 'load_failed' })
    expect(rpc).not.toHaveBeenCalled()
  })
  it('load_failed when the target wave cannot be read, before any write', async () => {
    const { db, rpc } = happyDb({ waveAnswer: { data: null, error: { message: 'timeout' } } })
    expect(await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor })).toEqual({ ok: false, error: 'load_failed' })
    expect(rpc).not.toHaveBeenCalled()
  })
  it('target_unavailable when the target is missing or cannot be read', async () => {
    for (const targetAnswer of [{ data: null }, { data: null, error: { message: 'timeout' } }]) {
      const { db, rpc } = happyDb({ targetAnswer })
      expect(await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor })).toMatchObject({ ok: false, error: 'target_unavailable' })
      expect(rpc).not.toHaveBeenCalled()
    }
  })
  it('prices a roster-less team for its whole size, matching p_headcount', async () => {
    const reg = { ...REG, teams: { ...REG.teams, size: 4, team_members: [] } }
    const { db, rpc } = happyDb({ reg })
    const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false })
    expect(r.ok).toBe(true)
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_headcount: 4, p_price_gap_cents: 4 * 500 })
  })
  describe('expectedSourceEventId (the row the caller authorised)', () => {
    it('conflict, before any write, when the entry is no longer on that event', async () => {
      const { db, rpc } = happyDb()
      const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, expectedSourceEventId: 'e-elsewhere' })
      expect(r).toEqual({ ok: false, error: 'conflict' })
      expect(rpc).not.toHaveBeenCalled()
      expect(db.calls.filter((c) => c.table !== 'race_registrations')).toEqual([])
    })
    it('goes ahead when it matches, and when it is not given', async () => {
      const a = happyDb()
      expect((await moveRegistration(a.db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false, expectedSourceEventId: 'e1' })).ok).toBe(true)
      const b = happyDb()
      expect((await moveRegistration(b.db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false })).ok).toBe(true)
    })
  })
  describe('notified (the moved email outcome)', () => {
    const run = (notify = true) => moveRegistration(happyDb().db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify })
    it('true only when the sender reports an email sent', async () => {
      sendMovedEmail.mockResolvedValueOnce({ sent: ['email'], skipped: [], failed: [] })
      const r = await run()
      expect(r).toMatchObject({ ok: true, notified: true })
      expect(sendMovedEmail).toHaveBeenCalledWith(expect.anything(), { registrationId: 'r1', moveId: 'mv1' })
    })
    it('false when the sender skipped or failed', async () => {
      sendMovedEmail.mockResolvedValueOnce({ sent: [], skipped: ['email:already_sent'], failed: [] })
      expect(await run()).toMatchObject({ ok: true, notified: false })
      sendMovedEmail.mockResolvedValueOnce({ sent: [], skipped: [], failed: ['email'] })
      expect(await run()).toMatchObject({ ok: true, notified: false })
      sendMovedEmail.mockResolvedValueOnce(undefined)
      expect(await run()).toMatchObject({ ok: true, notified: false })
    })
    it('false when the sender threw, and the move stands', async () => {
      // The default mock throws.
      expect(await run()).toMatchObject({ ok: true, notified: false })
    })
    it('false without calling the sender when notify is false', async () => {
      sendMovedEmail.mockClear()
      expect(await run(false)).toMatchObject({ ok: true, notified: false })
      expect(sendMovedEmail).not.toHaveBeenCalled()
    })
  })
  describe('the race.moved contact event', () => {
    it('resolves the lead with entryLeadEmail, the one rule (re-exported here)', async () => {
      expect(entryLeadEmail).toBe(entryLeadEmailBrowserSafe)
      // A blank contact email is no email: entryLeadEmail falls through to the captain.
      const { db } = happyDb({ reg: { ...REG, contact: { id: 'c1', email: '   ' } } })
      await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false })
      const ins = db.calls.filter((c) => c.table === 'contact_events').map((c) => c.ops.find((o) => o[0] === 'insert')[1])
      expect(ins[0].contact_email).toBe('captain@example.test')
    })
    const emitted = (db) => db.calls.filter((c) => c.table === 'contact_events').map((c) => c.ops.find((o) => o[0] === 'insert')[1])
    it('goes to the lead contact', async () => {
      const { db } = happyDb()
      await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false })
      expect(emitted(db)).toEqual([expect.objectContaining({ event_type: 'race.moved', contact_email: 'lead@example.test', contact_id: 'c1' })])
    })
    it('falls back to the captain, then the first member', async () => {
      const a = happyDb({ reg: { ...REG, contact: null } })
      await moveRegistration(a.db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false })
      expect(emitted(a.db)[0].contact_email).toBe('captain@example.test')
      const members = [{ id: 'm2', name: 'Dan', role: 'member', is_member: false, email: 'dan@example.test' }, { id: 'm3', name: 'Eve', role: 'member', is_member: false }]
      const b = happyDb({ reg: { ...REG, contact: null, teams: { ...REG.teams, team_members: members } } })
      await moveRegistration(b.db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false })
      expect(emitted(b.db)[0].contact_email).toBe('dan@example.test')
    })
    it('is skipped when nobody on the entry has an email, and the move stands', async () => {
      const { db } = happyDb({ reg: { ...REG, contact: { id: 'c1' }, teams: null, team_id: null } })
      const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false })
      expect(r.ok).toBe(true)
      expect(emitted(db)).toEqual([])
    })
  })
  it('a conflict raised under the row lock (P0003) is conflict; any other function error is write_failed', async () => {
    const answers = [
      [{ code: 'P0003', message: 'conflict' }, 'conflict'],
      // The SQLSTATE decides, never the wording: a message that merely says
      // "conflict" (a unique violation, a PostgREST 409) is a failed write.
      [{ message: 'conflict' }, 'write_failed'],
      [{ code: '23505', message: 'duplicate key value violates unique constraint; conflict' }, 'write_failed'],
      [{ code: 'P0002', message: 'not_found' }, 'write_failed'],
    ]
    for (const [err, expected] of answers) {
      const { db } = happyDb()
      db.rpc = vi.fn(async () => ({ data: null, error: err }))
      const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor })
      expect(r).toEqual({ ok: false, error: expected })
    }
  })
  it('actor.type is required: a missing one is a programming error, thrown before any read', async () => {
    const { db, rpc } = happyDb()
    await expect(moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor: { id: 'u1', name: 'R' } }))
      .rejects.toThrow(new TypeError('actor.type is required'))
    await expect(moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9' })).rejects.toThrow(TypeError)
    expect(db.calls).toHaveLength(0)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('wrong_event when the wave is not one of the target\'s waves', async () => {
    const { db, rpc } = happyDb()
    expect(await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w-elsewhere', actor }))
      .toMatchObject({ ok: false, error: 'wrong_event' })
    expect(rpc).not.toHaveBeenCalled()
  })
  it('a cross-studio move goes ahead even when the team has an entry on the target', async () => {
    const target = { ...TARGET, location_id: 'L2', locations: { id: 'L2', name: 'Stillorgan' } }
    const { db, rpc } = happyDb({ target, existingOnTarget: { id: 'r7', status: 'confirmed' } })
    const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false })
    expect(r.ok).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(1)
    const same = happyDb({ existingOnTarget: { id: 'r7', status: 'confirmed' } })
    expect(await moveRegistration(same.db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor }))
      .toMatchObject({ ok: false, error: 'already_entered' })
  })
  describe('the timeline line', () => {
    const activity = (db) => db.calls.find((c) => c.table === 'activities')?.ops.find((o) => o[0] === 'insert')?.[1]
    it('lands on the lead contact at their home studio, saying from, to and who', async () => {
      const reg = { ...REG, contact: { ...REG.contact, location_id: 'L-home' } }
      const { db } = happyDb({ reg })
      await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, note: 'Asked by phone', notify: false })
      expect(activity(db)).toEqual({
        contact_id: 'c1', location_id: 'L-home', kind: 'event', type: 'event',
        subject: 'Entry moved from Hatch Oct 18 to Hatch Oct 25 by Richard',
        note: 'From Hatch Oct 18 (2026-10-18) to Hatch Oct 25 (2026-10-25). Note: Asked by phone',
        done: true,
      })
    })
    it('falls back to the source event\'s studio when the contact has none', async () => {
      const target = { ...TARGET, location_id: 'L2', locations: { id: 'L2', name: 'Stillorgan' } }
      const { db } = happyDb({ reg: { ...REG, contact: { ...REG.contact, location_id: null } }, target })
      await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false })
      expect(activity(db).location_id).toBe('L1')
    })
  })
  it('syncs the host contact list only when the target has a host', async () => {
    syncHostList.mockClear()
    const plain = happyDb()
    await moveRegistration(plain.db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false })
    expect(syncHostList).not.toHaveBeenCalled()
    const hostedReg = { ...REG, race: { ...REG.race, host_id: 'h1' } }
    const hosted = happyDb({ reg: hostedReg, target: { ...TARGET, host_id: 'h1' } })
    const r = await moveRegistration(hosted.db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: false })
    expect(r.ok).toBe(true)
    expect(syncHostList).toHaveBeenCalledWith(hosted.db, 'e2')
  })
  it('a failing moved email never fails the move', async () => {
    const { db, rpc } = happyDb()
    const r = await moveRegistration(db, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor, notify: true })
    expect(r).toMatchObject({ ok: true, move: { id: 'mv1' } })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(sendMovedEmail).toHaveBeenCalledWith(db, { registrationId: 'r1', moveId: 'mv1' })
  })
})

describe('listMoveTargets — lead_first_name follows entryLeadEmail', () => {
  const targetsFor = async (registration) => {
    const db = fakeDb({
      race_registrations: (q) => (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id') ? { data: registration } : { data: [] }),
      race_events: { data: [TARGET] },
    })
    return listMoveTargets(db, { registrationId: 'r1', allowedLocationIds: ['L1'], today: '2026-10-08' })
  }
  const members = (list) => ({ ...REG.teams, team_members: list })
  it('the lead contact when it has an email', async () => {
    const r = await targetsFor({ ...REG, contact: { ...REG.contact, first_name: 'Siobhan Mary' } })
    expect(r.entry.lead_first_name).toBe('Siobhan')
  })
  it('the captain when the contact has no email', async () => {
    const r = await targetsFor({ ...REG, contact: { ...REG.contact, email: '  ' }, teams: members([{ name: 'Dan Ryan', role: 'member', email: 'dan@example.test' }, { name: 'Ciara Walsh', role: 'captain', email: 'ciara@example.test' }]) })
    expect(r.entry.lead_first_name).toBe('Ciara')
  })
  it('the first member with an email when neither contact nor captain has one', async () => {
    const r = await targetsFor({ ...REG, contact: null, teams: members([{ name: 'Ciara Walsh', role: 'captain', email: null }, { name: 'Noel', role: 'member' }, { name: 'Dan Ryan', role: 'member', email: 'dan@example.test' }]) })
    expect(r.entry.lead_first_name).toBe('Dan')
  })
  it('null when nobody on the entry has an email', async () => {
    const r = await targetsFor({ ...REG, contact: { first_name: 'Aoife', email: null }, teams: members([{ name: 'Ciara', role: 'captain' }]) })
    expect(r.entry.lead_first_name).toBeNull()
  })
  it('null when the contact is written to but has no first name (never another person)', async () => {
    const r = await targetsFor({ ...REG, contact: { first_name: '', email: 'lead@example.test' } })
    expect(r.entry.lead_first_name).toBeNull()
  })
})

// EVENT-MOVE.6 — the dry run the customer route takes BEFORE money moves: the
// same rules and the same gap as moveRegistration, and nothing written.
describe('checkMove', () => {
  function db(over = {}) {
    const rpc = vi.fn()
    const d = fakeDb({
      race_registrations: (q) => {
        if (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id')) return { data: over.reg ?? REG }
        if (q.ops.some((o) => o[0] === 'eq' && o[1] === 'team_id')) return { data: null }
        return { data: over.waveRegs ?? [] }
      },
      race_events: { data: TARGET },
      race_checkins: { data: null, count: over.checkins ?? 0, error: null },
    }, { rpc })
    return { d, rpc }
  }

  it('answers ok with the price gap and the loaded rows, and writes nothing', async () => {
    const { d, rpc } = db()
    const r = await checkMove(d, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', today: '2026-10-08' })
    expect(r).toMatchObject({ ok: true, priceGapCents: 1000, headcount: 2 })
    expect(r.registration.id).toBe('r1')
    expect(r.targetEvent.id).toBe('e2')
    expect(r.targetWave.id).toBe('w9')
    expect(rpc).not.toHaveBeenCalled()
    expect(d.calls.some((c) => c.ops.some((o) => o[0] === 'update' || o[0] === 'insert'))).toBe(false)
  })
  it('refuses a full time without force, the same as the move', async () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, status: 'confirmed', team: { size: 1 } }))
    const { d } = db({ waveRegs: full })
    expect(await checkMove(d, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', today: '2026-10-08' }))
      .toMatchObject({ ok: false, error: 'wave_full' })
  })
  it('refuses conflict when the entry left the event the caller judged', async () => {
    const { d } = db()
    expect(await checkMove(d, { registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', expectedSourceEventId: 'e9', today: '2026-10-08' }))
      .toEqual({ ok: false, error: 'conflict' })
  })
})
