// EVENT-MOVE.3 — POST /api/event-registrations/[id]/moves/[moveId]/settle.
// Pins the gate (the entry's CURRENT event studio, the move route's rule),
// the body, the move-belongs-to-entry check, no_gap, idempotence and the
// compare-and-set write.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// One builder for the two registration_moves calls: the read ends in
// maybeSingle() (answers globalThis.__move), the write ends in select()
// after update() (answers globalThis.__write). Every call is recorded.
vi.mock('@/lib/supabase', () => {
  const make = () => {
    const ops = []
    globalThis.__ops.push(ops)
    let writing = false
    const b = {
      select: (...a) => { ops.push(['select', ...a]); return writing ? Promise.resolve(globalThis.__write) : b },
      eq: (...a) => { ops.push(['eq', ...a]); return b },
      is: (...a) => { ops.push(['is', ...a]); return b },
      update: (...a) => { ops.push(['update', ...a]); writing = true; return b },
      maybeSingle: async () => globalThis.__move,
    }
    return b
  }
  return { createServerClient: vi.fn(() => ({ from: (t) => { globalThis.__tables.push(t); return make() } })) }
})
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/registration-move', async (importOriginal) => ({
  ...(await importOriginal()),
  readRegistrationForMove: vi.fn(),
}))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { readRegistrationForMove } = await import('@/lib/registration-move')
const { logError } = await import('@/lib/log')
const { POST } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const L2 = 'a0000000-0000-0000-0000-000000000002'
const E1 = 'e0000000-0000-0000-0000-000000000001'
const R1 = 'c0000000-0000-0000-0000-000000000001'
const R2 = 'c0000000-0000-0000-0000-000000000002'
const MV = 'd0000000-0000-0000-0000-000000000001'
// Same shape as the move route test's builder (src/lib/permissions.js
// hasPermissionForLocation + src/lib/role-at-location.js hasRoleAtLocation).
const manager = (locs, role = 'manager', races = true) => ({
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role, profileRole: role,
  activeLocation: { id: locs[0] },
  rolesByLocation: Object.fromEntries(locs.map((l) => [l, role])),
  assignmentsByLocation: Object.fromEntries(locs.map((l) => [l, { role, permissions: { races } }])),
  locations: locs.map((id) => ({ id, role, features: { races: true } })),
})
const props = (id = R1, moveId = MV) => ({ params: Promise.resolve({ id, moveId }) })
const post = (body) => new Request(`http://localhost/api/event-registrations/${R1}/moves/${MV}/settle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const MOVE = { id: MV, registration_id: R1, price_gap_cents: 1000, gap_settled_at: null, gap_settled_how: null, gap_settled_by_name: null }
const writes = () => globalThis.__ops.filter((ops) => ops.some((o) => o[0] === 'update'))

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.__ops = []
  globalThis.__tables = []
  globalThis.__move = { data: { ...MOVE }, error: null }
  globalThis.__write = { data: [{ ...MOVE, gap_settled_at: '2026-10-09T10:00:00Z', gap_settled_how: 'collected', gap_settled_by_name: 'Richard' }], error: null }
  readRegistrationForMove.mockResolvedValue({ registration: { id: R1, race_event_id: E1, race: { id: E1, location_id: L1 } }, error: null })
})

describe('POST /api/event-registrations/[id]/moves/[moveId]/settle', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(post({ how: 'collected' }), props())).status).toBe(401)
    expect(readRegistrationForMove).not.toHaveBeenCalled()
  })
  it('403 for a caller holding races nowhere, without a read', async () => {
    getCurrentUser.mockResolvedValue(manager([L1], 'manager', false))
    expect((await POST(post({ how: 'collected' }), props())).status).toBe(403)
    expect(readRegistrationForMove).not.toHaveBeenCalled()
  })
  it.each([['entry', 'nope', MV], ['move', R1, 'nope']])('404 for a %s id that is not uuid-shaped, without a read', async (_w, id, moveId) => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await POST(post({ how: 'collected' }), props(id, moveId))).status).toBe(404)
    expect(readRegistrationForMove).not.toHaveBeenCalled()
  })
  it('404 when the entry does not exist', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    readRegistrationForMove.mockResolvedValue({ registration: null, error: null })
    expect((await POST(post({ how: 'collected' }), props())).status).toBe(404)
    expect(globalThis.__tables).toEqual([])
  })
  it('500 load_failed when the entry read fails (not a 404)', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    readRegistrationForMove.mockResolvedValue({ registration: null, error: { message: 'boom' } })
    const res = await POST(post({ how: 'collected' }), props())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: 'load_failed' })
  })
  it('404 when the entry\'s CURRENT event studio is not the caller\'s', async () => {
    getCurrentUser.mockResolvedValue(manager([L2]))
    expect((await POST(post({ how: 'collected' }), props())).status).toBe(404)
    expect(globalThis.__tables).toEqual([])
  })
  it('404 when the entry\'s event has no studio', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    readRegistrationForMove.mockResolvedValue({ registration: { id: R1, race_event_id: E1, race: null }, error: null })
    expect((await POST(post({ how: 'collected' }), props())).status).toBe(404)
  })
  it('403 for a non-manager at the studio', async () => {
    getCurrentUser.mockResolvedValue(manager([L1], 'staff'))
    expect((await POST(post({ how: 'collected' }), props())).status).toBe(403)
    expect(globalThis.__tables).toEqual([])
  })
  it('403 for a manager without races at the studio', async () => {
    const u = manager([L1, L2])
    u.assignmentsByLocation[L1].permissions.races = false
    getCurrentUser.mockResolvedValue(u)
    expect((await POST(post({ how: 'collected' }), props())).status).toBe(403)
    expect(globalThis.__tables).toEqual([])
  })
  it.each([[{}], [{ how: 'refunded' }], [{ how: null }]])('400 on a bad body %j', async (body) => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await POST(post(body), props())).status).toBe(400)
    expect(globalThis.__tables).toEqual([])
  })
  it('404 when the move does not exist', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    globalThis.__move = { data: null, error: null }
    expect((await POST(post({ how: 'collected' }), props())).status).toBe(404)
    expect(writes()).toHaveLength(0)
  })
  it('404 when the move belongs to another entry', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    globalThis.__move = { data: { ...MOVE, registration_id: R2 }, error: null }
    expect((await POST(post({ how: 'collected' }), props())).status).toBe(404)
    expect(writes()).toHaveLength(0)
  })
  it('500 load_failed when the move read fails', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    globalThis.__move = { data: null, error: { message: 'boom' } }
    const res = await POST(post({ how: 'collected' }), props())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: 'load_failed' })
    expect(writes()).toHaveLength(0)
  })
  it.each([0, -500])('400 no_gap when the gap is %i', async (gap) => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    globalThis.__move = { data: { ...MOVE, price_gap_cents: gap }, error: null }
    const res = await POST(post({ how: 'waived' }), props())
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ success: false, error: 'no_gap', message: expect.any(String) })
    expect(writes()).toHaveLength(0)
  })
  it('200 unchanged when the move is already settled, without a write', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    const settled = { ...MOVE, gap_settled_at: '2026-10-08T10:00:00Z', gap_settled_how: 'waived', gap_settled_by_name: 'Colm' }
    globalThis.__move = { data: settled, error: null }
    const res = await POST(post({ how: 'collected' }), props())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { unchanged: true, move: settled } })
    expect(writes()).toHaveLength(0)
  })
  it('200 settles with a compare-and-set and answers the settled row', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    const res = await POST(post({ how: 'collected' }), props())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { unchanged: false, move: globalThis.__write.data[0] } })
    const [w] = writes()
    const patch = w.find((o) => o[0] === 'update')[1]
    expect(patch).toEqual({ gap_settled_at: expect.any(String), gap_settled_how: 'collected', gap_settled_by_name: 'Richard' })
    expect(Number.isNaN(Date.parse(patch.gap_settled_at))).toBe(false)
    expect(w).toContainEqual(['eq', 'id', MV])
    expect(w).toContainEqual(['is', 'gap_settled_at', null])
    expect(w.at(-1)[0]).toBe('select')
    expect(w.at(-1)[1]).toMatch(/^id\b/)
    expect(globalThis.__tables).toEqual(['registration_moves', 'registration_moves'])
  })
  it('writes waived as waived', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    await POST(post({ how: 'waived' }), props())
    expect(writes()[0].find((o) => o[0] === 'update')[1].gap_settled_how).toBe('waived')
  })
  it('500 write_failed when the write errors, logged', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    globalThis.__write = { data: null, error: { message: 'boom' } }
    const res = await POST(post({ how: 'collected' }), props())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: 'write_failed', message: expect.any(String) })
    expect(logError).toHaveBeenCalledTimes(1)
  })
  it('a lost compare-and-set (zero rows) answers 200 unchanged and re-reads nothing', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    globalThis.__write = { data: [], error: null }
    const res = await POST(post({ how: 'collected' }), props())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, data: { unchanged: true } })
    expect(globalThis.__tables).toEqual(['registration_moves', 'registration_moves'])
  })
  it('records the REAL caller when a master is impersonating', async () => {
    getCurrentUser.mockResolvedValue({
      ...manager([L1]), id: 'u1', full_name: 'Colm',
      impersonatingFrom: { masterId: 'm1', masterName: 'Richard', masterEmail: 'r@x.ie' },
    })
    await POST(post({ how: 'collected' }), props())
    expect(writes()[0].find((o) => o[0] === 'update')[1].gap_settled_by_name).toBe('Richard as Colm')
  })
  it('falls back to emails in the impersonation name', async () => {
    getCurrentUser.mockResolvedValue({
      ...manager([L1]), id: 'u1', full_name: null, email: 'colm@x.ie',
      impersonatingFrom: { masterId: 'm1', masterName: null, masterEmail: 'r@x.ie' },
    })
    await POST(post({ how: 'collected' }), props())
    expect(writes()[0].find((o) => o[0] === 'update')[1].gap_settled_by_name).toBe('r@x.ie as colm@x.ie')
  })
  it('a master passes with no per-location rows', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'm1', full_name: 'Master', email: 'm@x.ie', role: 'master', profileRole: 'master',
      activeLocation: { id: L1 }, rolesByLocation: {}, assignmentsByLocation: {},
      locations: [{ id: L1, features: { races: true } }],
    })
    expect((await POST(post({ how: 'collected' }), props())).status).toBe(200)
    expect(writes()[0].find((o) => o[0] === 'update')[1].gap_settled_by_name).toBe('Master')
  })
})
