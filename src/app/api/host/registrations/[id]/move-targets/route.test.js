// EVENT-MOVE.2 — GET /api/host/registrations/[id]/move-targets. The host's
// OWN events an entry may move to. Pins the host gate, the own-event 404 and
// the fence handed to the lib (allowedEventIds = own events, no studio fence).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ getCurrentHost: vi.fn(), createServerClient: vi.fn(), readRegistrationForMove: vi.fn(), listMoveTargets: vi.fn() }))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: mocks.getCurrentHost }))
vi.mock('@/lib/supabase', () => ({ createServerClient: mocks.createServerClient }))
vi.mock('@/lib/registration-move', async (importOriginal) => ({ ...(await importOriginal()), readRegistrationForMove: mocks.readRegistrationForMove, listMoveTargets: mocks.listMoveTargets }))

const { GET } = await import('./route.js')

const H1 = 'h0000000-0000-0000-0000-000000000001'
const E1 = 'e0000000-0000-0000-0000-000000000001'
const E2 = 'e0000000-0000-0000-0000-000000000002'
const E9 = 'e0000000-0000-0000-0000-000000000009'
const R1 = 'a0000000-0000-0000-0000-000000000001'
const session = () => ({ host: { id: H1, name: 'Pride Training Club' }, authUserId: 'u1', email: 'colm@x.ie' })
const props = (id = R1) => ({ params: Promise.resolve({ id }) })
const get = () => new Request(`http://localhost/api/host/registrations/${R1}/move-targets`)

function dbWith({ ownEvents = [E1, E2], eventsError = null } = {}) {
  const calls = []
  const b = { select: (...a) => { calls.push(['select', ...a]); return b }, eq: (...a) => { calls.push(['eq', ...a]); return b }, then: (res, rej) => Promise.resolve({ data: eventsError ? null : ownEvents.map((id) => ({ id })), error: eventsError }).then(res, rej) }
  return { calls, from: vi.fn(() => b) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readRegistrationForMove.mockResolvedValue({ registration: { id: R1, status: 'confirmed', race_event_id: E1, race: { id: E1, host_id: H1, location_id: 'L1' } }, error: null })
  mocks.listMoveTargets.mockResolvedValue({ ok: true, entry: { id: R1 }, source: { id: E1 }, targets: [{ id: E2 }] })
})

describe('GET /api/host/registrations/[id]/move-targets', () => {
  it('401 without a host session, before any read', async () => {
    mocks.getCurrentHost.mockResolvedValue(null)
    expect((await GET(get(), props())).status).toBe(401)
    expect(mocks.readRegistrationForMove).not.toHaveBeenCalled()
    expect(mocks.listMoveTargets).not.toHaveBeenCalled()
  })
  it('404 for an entry on another host\'s event, and for an internal event (no host)', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.createServerClient.mockReturnValue(dbWith())
    mocks.readRegistrationForMove.mockResolvedValueOnce({ registration: { id: R1, status: 'confirmed', race_event_id: E9, race: { id: E9, host_id: 'other', location_id: 'L1' } }, error: null })
    expect((await GET(get(), props())).status).toBe(404)
    mocks.readRegistrationForMove.mockResolvedValueOnce({ registration: { id: R1, status: 'confirmed', race_event_id: E9, race: { id: E9, host_id: null, location_id: 'L1' } }, error: null })
    expect((await GET(get(), props())).status).toBe(404)
    expect(mocks.listMoveTargets).not.toHaveBeenCalled()
  })
  it('404 for a malformed id without reading it', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    expect((await GET(get(), props('nope'))).status).toBe(404)
    expect(mocks.readRegistrationForMove).not.toHaveBeenCalled()
  })
  it('500 when the entry read fails', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.createServerClient.mockReturnValue(dbWith())
    mocks.readRegistrationForMove.mockResolvedValueOnce({ registration: null, error: { message: 'boom' } })
    const res = await GET(get(), props())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('load_failed')
  })
  it('200 passes the own-event fence and no studio fence', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    const db = dbWith()
    mocks.createServerClient.mockReturnValue(db)
    const res = await GET(get(), props())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { entry: { id: R1 }, source: { id: E1 }, targets: [{ id: E2 }] } })
    expect(db.from).toHaveBeenCalledWith('race_events')
    expect(db.calls).toContainEqual(['eq', 'host_id', H1])
    const args = mocks.listMoveTargets.mock.calls[0][1]
    expect(args.registrationId).toBe(R1)
    expect(args.allowedLocationIds).toBeNull()
    expect(args.allowedEventIds).toBeInstanceOf(Set)
    expect([...args.allowedEventIds]).toEqual([E1, E2])
  })
  it('500 when the own-events read fails, before the lib runs', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.createServerClient.mockReturnValue(dbWith({ eventsError: { message: 'boom' } }))
    expect((await GET(get(), props())).status).toBe(500)
    expect(mocks.listMoveTargets).not.toHaveBeenCalled()
  })
  it('maps a lib load_failed to 500 and not_found to 404', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.createServerClient.mockReturnValue(dbWith())
    mocks.listMoveTargets.mockResolvedValueOnce({ ok: false, error: 'load_failed' })
    const res = await GET(get(), props())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: 'load_failed', message: expect.any(String) })
    mocks.listMoveTargets.mockResolvedValueOnce({ ok: false, error: 'not_found' })
    expect((await GET(get(), props())).status).toBe(404)
  })
})
