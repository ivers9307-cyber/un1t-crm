// EVENT-MOVE.2 — POST /api/host/registrations/[id]/move. A host moves ONE of
// their own entries to another of their OWN events. The lib's rules are tested
// in src/lib/registration-move.test.js; this pins the host gate, the own-event
// fence, pending_payment, the mapping and the actor.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ getCurrentHost: vi.fn(), createServerClient: vi.fn(), readRegistrationForMove: vi.fn(), moveRegistration: vi.fn() }))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: mocks.getCurrentHost }))
vi.mock('@/lib/supabase', () => ({ createServerClient: mocks.createServerClient }))
vi.mock('@/lib/registration-move', async (importOriginal) => ({ ...(await importOriginal()), readRegistrationForMove: mocks.readRegistrationForMove, moveRegistration: mocks.moveRegistration }))

const { POST } = await import('./route.js')

const H1 = 'h0000000-0000-0000-0000-000000000001'
const E1 = 'e0000000-0000-0000-0000-000000000001'
const E2 = 'e0000000-0000-0000-0000-000000000002'
const E9 = 'e0000000-0000-0000-0000-000000000009'
const W9 = 'f0000000-0000-0000-0000-000000000009'
const R1 = 'a0000000-0000-0000-0000-000000000001'
const session = (over = {}) => ({ host: { id: H1, name: 'Pride Training Club' }, authUserId: 'u1', email: 'colm@x.ie', ...over })
const props = { params: Promise.resolve({ id: R1 }) }
const post = (body) => new Request(`http://localhost/api/host/registrations/${R1}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const BODY = { target_event_id: E2, target_wave_id: W9 }

// The route reads the host's own event ids once: `from('race_events').select('id').eq('host_id', H1)`.
function dbWith({ ownEvents = [E1, E2], eventsError = null } = {}) {
  const calls = []
  const b = { then: (res, rej) => Promise.resolve({ data: eventsError ? null : ownEvents.map((id) => ({ id })), error: eventsError }).then(res, rej) }
  for (const name of ['select', 'eq', 'gte']) b[name] = (...a) => { calls.push([name, ...a]); return b }
  return { calls, from: vi.fn(() => b) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createServerClient.mockReturnValue(dbWith())
  mocks.readRegistrationForMove.mockResolvedValue({ registration: { id: R1, status: 'confirmed', race_event_id: E1, race: { id: E1, host_id: H1, location_id: 'L1' } }, error: null })
  mocks.moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv1' }, registration: { id: R1 }, notified: true })
})

describe('POST /api/host/registrations/[id]/move', () => {
  it('401 without a host session', async () => {
    mocks.getCurrentHost.mockResolvedValue(null)
    expect((await POST(post(BODY), props)).status).toBe(401)
    expect(mocks.readRegistrationForMove).not.toHaveBeenCalled()
    expect(mocks.moveRegistration).not.toHaveBeenCalled()
  })
  it('404 for an entry on another host\'s event', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.readRegistrationForMove.mockResolvedValue({ registration: { id: R1, status: 'confirmed', race_event_id: E9, race: { id: E9, host_id: 'other', location_id: 'L1' } }, error: null })
    expect((await POST(post(BODY), props)).status).toBe(404)
    expect(mocks.moveRegistration).not.toHaveBeenCalled()
  })
  it('404 for a missing entry, 500 for a failed read', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.readRegistrationForMove.mockResolvedValueOnce({ registration: null, error: null })
    expect((await POST(post(BODY), props)).status).toBe(404)
    mocks.readRegistrationForMove.mockResolvedValueOnce({ registration: null, error: { message: 'boom' } })
    expect((await POST(post(BODY), props)).status).toBe(500)
  })
  it('400 pending_payment: a host cannot move an unpaid entry', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.readRegistrationForMove.mockResolvedValue({ registration: { id: R1, status: 'pending_payment', race_event_id: E1, race: { id: E1, host_id: H1, location_id: 'L1' } }, error: null })
    const res = await POST(post(BODY), props)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ success: false, error: 'pending_payment', message: expect.stringMatching(/awaiting payment/) })
    expect(mocks.moveRegistration).not.toHaveBeenCalled()
  })
  it('pending_payment is refused before the body is read (even a bad body)', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.readRegistrationForMove.mockResolvedValue({ registration: { id: R1, status: 'pending_payment', race_event_id: E1, race: { id: E1, host_id: H1, location_id: 'L1' } }, error: null })
    const res = await POST(post({ target_event_id: 'nope' }), props)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('pending_payment')
  })
  it('404 for an entry on an internal event (no host), never matching a null host', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.readRegistrationForMove.mockResolvedValue({ registration: { id: R1, status: 'confirmed', race_event_id: E9, race: { id: E9, host_id: null, location_id: 'L1' } }, error: null })
    expect((await POST(post(BODY), props)).status).toBe(404)
    expect(mocks.moveRegistration).not.toHaveBeenCalled()
  })
  it('400 on a bad body (after the gate)', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    expect((await POST(post({ target_event_id: 'nope' }), props)).status).toBe(400)
  })
  it('passes the own-event fence, the host actor and expectedSourceEventId to the lib', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    const db = dbWith()
    mocks.createServerClient.mockReturnValue(db)
    const res = await POST(post({ ...BODY, force: true, note: ' moved by host ' }), props)
    expect(res.status).toBe(200)
    expect(db.from).toHaveBeenCalledWith('race_events')
    expect(db.calls).toContainEqual(['eq', 'host_id', H1])
    expect(db.calls).toContainEqual(['eq', 'active', true])
    expect(db.calls).toContainEqual(['eq', 'status', 'published'])
    expect(db.calls.some((c) => c[0] === 'gte' && c[1] === 'race_date' && /^\d{4}-\d{2}-\d{2}$/.test(c[2]))).toBe(true)
    expect(await res.json()).toMatchObject({ success: true, data: { notified: true } })
    const args = mocks.moveRegistration.mock.calls[0][1]
    expect(args).toMatchObject({ registrationId: R1, targetEventId: E2, targetWaveId: W9, force: true, notify: true, note: 'moved by host', expectedSourceEventId: E1, actor: { type: 'host', id: H1, name: 'Pride Training Club' } })
    expect(args.allowedEventIds).toBeInstanceOf(Set)
    expect([...args.allowedEventIds]).toEqual([E1, E2])
  })
  it('names the admin under view-as', async () => {
    mocks.getCurrentHost.mockResolvedValue(session({ impersonatedBy: { id: 'adm' }, email: 'richard@x.ie' }))
    await POST(post(BODY), props)
    expect(mocks.moveRegistration.mock.calls[0][1].actor).toEqual({ type: 'host', id: H1, name: 'richard@x.ie as Pride Training Club' })
  })
  it('500 when the own-events read fails, before the lib runs', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.createServerClient.mockReturnValue(dbWith({ eventsError: { message: 'boom' } }))
    expect((await POST(post(BODY), props)).status).toBe(500)
    expect(mocks.moveRegistration).not.toHaveBeenCalled()
  })
  it('maps lib refusals like the staff route', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    for (const [error, status] of [['not_found', 404], ['wave_full', 409], ['conflict', 409], ['load_failed', 500], ['write_failed', 500], ['checked_in', 400]]) {
      mocks.moveRegistration.mockResolvedValueOnce({ ok: false, error, spots_left: error === 'wave_full' ? 0 : undefined })
      const res = await POST(post(BODY), props)
      expect(res.status).toBe(status)
      const j = await res.json()
      expect(j.error).toBe(error)
      expect(typeof j.message).toBe('string')
    }
  })
})
