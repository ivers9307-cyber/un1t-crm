// EVENT-MOVE.1 — GET /api/event-registrations/[id]/move-targets. The target
// rules live in src/lib/registration-move.test.js; this pins the gate at the
// source studio, the studios handed to the lib, and that a target is shown
// only where the caller could also MOVE it (races + a manager role there).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/registration-move', async (importOriginal) => ({
  ...(await importOriginal()),
  readRegistrationForMove: vi.fn(),
  listMoveTargets: vi.fn(),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { readRegistrationForMove, listMoveTargets } = await import('@/lib/registration-move')
const { GET } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const L2 = 'a0000000-0000-0000-0000-000000000002'
const L3 = 'a0000000-0000-0000-0000-000000000003'
const R1 = 'c0000000-0000-0000-0000-000000000001'
const manager = (locs, role = 'manager') => ({
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role, profileRole: role,
  activeLocation: { id: locs[0] },
  rolesByLocation: Object.fromEntries(locs.map((l) => [l, role])),
  assignmentsByLocation: Object.fromEntries(locs.map((l) => [l, { role, permissions: { races: true } }])),
  locations: locs.map((id) => ({ id, role, features: { races: true } })),
})
const props = (id = R1) => ({ params: Promise.resolve({ id }) })
const get = () => new Request(`http://localhost/api/event-registrations/${R1}/move-targets`)
const target = (id, location_id) => ({ id, location_id, name: id, waves: [] })

beforeEach(() => {
  vi.clearAllMocks()
  readRegistrationForMove.mockResolvedValue({ registration: { id: R1, race: { id: 'e1', location_id: L1 } }, error: null })
  listMoveTargets.mockResolvedValue({ ok: true, entry: { id: R1 }, source: { event_id: 'e1' }, targets: [] })
})

describe('GET /api/event-registrations/[id]/move-targets', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(get(), props())).status).toBe(401)
  })
  it('404 for an id that is not uuid-shaped, without a read', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await GET(get(), props('nope'))).status).toBe(404)
    expect(readRegistrationForMove).not.toHaveBeenCalled()
  })
  it('404 when the entry does not exist', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    readRegistrationForMove.mockResolvedValue({ registration: null, error: null })
    expect((await GET(get(), props())).status).toBe(404)
    expect(listMoveTargets).not.toHaveBeenCalled()
  })
  it('500 load_failed when the entry read fails (not a 404)', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    readRegistrationForMove.mockResolvedValue({ registration: null, error: { message: 'boom' } })
    const res = await GET(get(), props())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: 'load_failed' })
    expect(listMoveTargets).not.toHaveBeenCalled()
  })
  it('404 when the caller cannot see the source studio', async () => {
    getCurrentUser.mockResolvedValue(manager([L2]))
    expect((await GET(get(), props())).status).toBe(404)
    expect(listMoveTargets).not.toHaveBeenCalled()
  })
  it('403 for a non-manager at the source studio', async () => {
    getCurrentUser.mockResolvedValue(manager([L1], 'staff'))
    expect((await GET(get(), props())).status).toBe(403)
    expect(listMoveTargets).not.toHaveBeenCalled()
  })
  it('500 when the lib cannot load the targets', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    listMoveTargets.mockResolvedValue({ ok: false, error: 'load_failed' })
    const res = await GET(get(), props())
    expect(res.status).toBe(500)
    expect((await res.json()).message).toBeTruthy()
  })
  it('404 when the lib answers not_found', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    listMoveTargets.mockResolvedValue({ ok: false, error: 'not_found' })
    expect((await GET(get(), props())).status).toBe(404)
  })
  it("hands the lib the caller's studios and keeps only targets the caller could move to", async () => {
    const u = manager([L1, L2, L3])
    u.rolesByLocation[L2] = 'staff' // member at L2, but not a manager
    u.assignmentsByLocation[L3].permissions.races = false // manager at L3 without races
    getCurrentUser.mockResolvedValue(u)
    listMoveTargets.mockResolvedValue({
      ok: true, entry: { id: R1 }, source: { event_id: 'e1' },
      targets: [target('t1', L1), target('t2', L2), target('t3', L3)],
    })
    const res = await GET(get(), props())
    expect(res.status).toBe(200)
    expect(listMoveTargets).toHaveBeenCalledWith(expect.anything(), { registrationId: R1, allowedLocationIds: [L1, L2, L3] })
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.targets.map((t) => t.id)).toEqual(['t1'])
    expect(json.data.entry).toEqual({ id: R1 })
    expect(json.data.source).toEqual({ event_id: 'e1' })
  })
})
