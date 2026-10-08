// EVENT-MOVE.1 — GET /api/events/[id]/teams carries the move history: the
// latest move INTO this event per entry (`last_move`, the "Moved from" chip)
// and every move OUT of it (`moved_out`, the footer). A failed history read
// costs the chip or the footer, never the list.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// A chainable fake: each `from(table)` call records its ops; the awaited
// result comes from globalThis.__answer(table, ops).
vi.mock('@/lib/supabase', () => {
  const builder = (table) => {
    const ops = []
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (res, rej) => Promise.resolve(globalThis.__answer(table, ops)).then(res, rej)
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => Promise.resolve(globalThis.__answer(table, [...ops, [prop]]))
        }
        return (...args) => { ops.push([prop, ...args]); return b }
      },
    })
    globalThis.__calls.push({ table, ops })
    return b
  }
  return { createServerClient: vi.fn(() => ({ from: builder })) }
})
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: vi.fn() }))
vi.mock('@/lib/sequences', () => ({ triggerSequencesForRaceRegistered: vi.fn() }))
vi.mock('@/lib/host-contact-list', () => ({ addEventAttendeesToHostList: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { logError } = await import('@/lib/log')
const { GET } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const EV = 'e0000000-0000-0000-0000-000000000001'
const manager = {
  id: 'u1', role: 'manager', profileRole: 'manager', activeLocation: { id: L1 },
  rolesByLocation: { [L1]: 'manager' },
  assignmentsByLocation: { [L1]: { role: 'manager', permissions: { races: true } } },
  locations: [{ id: L1, role: 'manager', features: { races: true } }],
}
const props = { params: Promise.resolve({ id: EV }) }
const req = () => new Request(`http://localhost/api/events/${EV}/teams`)
const has = (ops, ...op) => ops.some((o) => JSON.stringify(o) === JSON.stringify(op))

const REGS = [
  { id: 'r1', status: 'confirmed', teams: { name: 'Fast Pair', size: 2, team_members: [{ name: 'A', role: 'captain' }, { name: 'B', role: 'member' }] } },
  { id: 'r2', status: 'confirmed', teams: { name: 'Solo', size: 1, team_members: [{ name: 'Cara', role: 'captain' }] } },
]
const MOVE_IN_NEW = { id: 'm2', registration_id: 'r1', created_at: '2026-10-07T10:00:00Z', actor_name: 'Richard', price_gap_cents: 500, forced: false, notified_at: null, from_event: { id: 'e9', name: 'Old', race_date: '2026-10-01' } }
const MOVE_IN_OLD = { id: 'm1', registration_id: 'r1', created_at: '2026-10-05T10:00:00Z', actor_name: 'Richard', price_gap_cents: 0, forced: false, notified_at: '2026-10-05T10:00:05Z', from_event: { id: 'e8', name: 'Older', race_date: '2026-09-01' } }
const MOVE_OUT = {
  id: 'm3', created_at: '2026-10-06T09:00:00Z', actor_name: 'Colm',
  registration: { id: 'r7', teams: { name: 'Gone Team', size: 2, team_members: [{ name: 'X', role: 'captain' }, { name: 'Y', role: 'member' }] } },
  to_event: { id: 'e2', name: 'Saturday', race_date: '2026-10-11' },
}

let moves
beforeEach(() => {
  vi.clearAllMocks()
  globalThis.__calls = []
  moves = { in: { data: [MOVE_IN_NEW, MOVE_IN_OLD], error: null }, out: { data: [MOVE_OUT], error: null } }
  getCurrentUser.mockResolvedValue(manager)
  globalThis.__answer = (table, ops) => {
    if (table === 'race_events') return { data: { id: EV, location_id: L1, allowed_team_sizes: null, waves: [] }, error: null }
    if (table === 'race_registrations') return { data: REGS.map((r) => ({ ...r })), error: null }
    if (table === 'race_payments') return { data: [], error: null }
    if (table === 'registration_moves') {
      if (has(ops, 'eq', 'to_event_id', EV)) return moves.in
      if (has(ops, 'eq', 'from_event_id', EV)) return moves.out
    }
    throw new Error(`unexpected read ${table} ${JSON.stringify(ops)}`)
  }
})

describe('GET /api/events/[id]/teams — move history', () => {
  it('attaches the LATEST move into this event per entry, null where none', async () => {
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.find((r) => r.id === 'r1').last_move).toEqual(MOVE_IN_NEW)
    expect(json.data.find((r) => r.id === 'r2').last_move).toBeNull()
    const movesIn = globalThis.__calls.find((c) => c.table === 'registration_moves' && has(c.ops, 'eq', 'to_event_id', EV))
    // One filter on the event, never a URL that grows with the entry list.
    expect(movesIn.ops.some((o) => o[0] === 'in')).toBe(false)
    expect(has(movesIn.ops, 'order', 'created_at', { ascending: false })).toBe(true)
  })

  it('ignores a move in whose entry is no longer on this event', async () => {
    const gone = { ...MOVE_IN_NEW, id: 'm9', registration_id: 'r-left-again', created_at: '2026-10-08T10:00:00Z' }
    moves.in = { data: [gone, MOVE_IN_NEW, MOVE_IN_OLD], error: null }
    const json = await (await GET(req(), props)).json()
    expect(json.data.find((r) => r.id === 'r1').last_move).toEqual(MOVE_IN_NEW)
    expect(json.data.find((r) => r.id === 'r2').last_move).toBeNull()
    expect(json.data.some((r) => r.last_move?.id === 'm9')).toBe(false)
  })

  it('reads notified_at on the move in, so the card can say it was not emailed', async () => {
    await GET(req(), props)
    const movesIn = globalThis.__calls.find((c) => c.table === 'registration_moves' && has(c.ops, 'eq', 'to_event_id', EV))
    const select = movesIn.ops.find((o) => o[0] === 'select')[1]
    expect(select.split(',').map((c) => c.trim())).toContain('notified_at')
  })

  it('lists every move out of this event with the entry label and target', async () => {
    const json = await (await GET(req(), props)).json()
    expect(json.moved_out).toEqual([{
      id: 'm3', created_at: '2026-10-06T09:00:00Z', actor_name: 'Colm',
      label: 'Gone Team', to_event: { id: 'e2', name: 'Saturday', race_date: '2026-10-11' },
    }])
    const movesOut = globalThis.__calls.find((c) => c.table === 'registration_moves' && has(c.ops, 'eq', 'from_event_id', EV))
    expect(has(movesOut.ops, 'order', 'created_at', { ascending: false })).toBe(true)
    expect(has(movesOut.ops, 'limit', 200)).toBe(true)
  })

  it('labels a team-less moved-out entry by its lead contact', async () => {
    moves.out = { data: [{ ...MOVE_OUT, registration: { id: 'r8', teams: null, contact: { first_name: 'Dana', last_name: 'Kelly' } } }], error: null }
    const json = await (await GET(req(), props)).json()
    expect(json.moved_out[0].label).toBe('Dana Kelly')
  })

  it('a failed moves-in read omits the chips, logs, and still answers the list', async () => {
    moves.in = { data: null, error: { message: 'boom' } }
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toHaveLength(2)
    expect(json.data.every((r) => r.last_move === null)).toBe(true)
    expect(json.moved_out).toHaveLength(1)
    expect(logError).toHaveBeenCalled()
  })

  it('a failed moves-out read omits the footer, logs, and still answers the list', async () => {
    moves.out = { data: null, error: { message: 'boom' } }
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toHaveLength(2)
    expect(json.moved_out).toEqual([])
    expect(json.data.find((r) => r.id === 'r1').last_move).toEqual(MOVE_IN_NEW)
    expect(logError).toHaveBeenCalled()
  })

  it('a history read that THROWS still answers the list', async () => {
    const answer = globalThis.__answer
    globalThis.__answer = (table, ops) => {
      if (table === 'registration_moves') throw new Error('network down')
      return answer(table, ops)
    }
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toHaveLength(2)
    expect(json.data.every((r) => r.last_move === null)).toBe(true)
    expect(json.moved_out).toEqual([])
  })

  it('an event with no entries still reads the moves out of it', async () => {
    const answer = globalThis.__answer
    globalThis.__answer = (table, ops) => (table === 'race_registrations' ? { data: [], error: null } : answer(table, ops))
    const json = await (await GET(req(), props)).json()
    expect(json.data).toEqual([])
    expect(json.moved_out).toHaveLength(1)
    expect(globalThis.__calls.some((c) => c.table === 'registration_moves' && has(c.ops, 'eq', 'to_event_id', EV))).toBe(false)
  })
})
