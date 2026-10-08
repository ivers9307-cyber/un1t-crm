// EVENT-MOVE.1 — POST /api/event-registrations/[id]/move. The rules live in
// src/lib/registration-move.test.js; this pins the gate (both studios), the
// schema, the error mapping and the actor handed to the lib.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The route reads the target event itself (id + studio) to judge the target
// studio. One tiny builder answers that read; __target steers it per test.
vi.mock('@/lib/supabase', () => {
  const b = {
    select: () => b, eq: () => b,
    maybeSingle: async () => globalThis.__target,
  }
  return { createServerClient: vi.fn(() => ({ from: () => b })) }
})
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/registration-move', async (importOriginal) => ({
  ...(await importOriginal()),
  readRegistrationForMove: vi.fn(),
  moveRegistration: vi.fn(),
}))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { readRegistrationForMove, moveRegistration } = await import('@/lib/registration-move')
const { POST } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const L2 = 'a0000000-0000-0000-0000-000000000002'
const E1 = 'e0000000-0000-0000-0000-000000000001'
const E2 = 'e0000000-0000-0000-0000-000000000002'
const W9 = 'f0000000-0000-0000-0000-000000000009'
const R1 = 'c0000000-0000-0000-0000-000000000001'
// Shape per src/lib/permissions.js hasPermissionForLocation (reads
// locations[].role / features and assignmentsByLocation[].permissions) and
// src/lib/role-at-location.js hasRoleAtLocation (reads rolesByLocation[loc]
// as a STRING). Pass a role of 'staff' to make a non-manager.
const manager = (locs, role = 'manager', races = true) => ({
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role, profileRole: role,
  activeLocation: { id: locs[0] },
  rolesByLocation: Object.fromEntries(locs.map((l) => [l, role])),
  assignmentsByLocation: Object.fromEntries(locs.map((l) => [l, { role, permissions: { races } }])),
  locations: locs.map((id) => ({ id, role, features: { races: true } })),
})
const props = (id = R1) => ({ params: Promise.resolve({ id }) })
const post = (body) => new Request(`http://localhost/api/event-registrations/${R1}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const BODY = { target_event_id: E2, target_wave_id: W9, notify: true }
const targetAt = (location_id) => ({ data: { id: E2, location_id }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.__target = targetAt(L1)
  readRegistrationForMove.mockResolvedValue({ registration: { id: R1, race: { id: E1, location_id: L1 } }, error: null })
})

describe('POST /api/event-registrations/[id]/move', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(post(BODY), props())).status).toBe(401)
  })
  it('403 for a caller holding races nowhere', async () => {
    getCurrentUser.mockResolvedValue(manager([L1], 'manager', false))
    expect((await POST(post(BODY), props())).status).toBe(403)
    expect(readRegistrationForMove).not.toHaveBeenCalled()
  })
  it('404 for an id that is not uuid-shaped, without a read', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await POST(post(BODY), props('nope'))).status).toBe(404)
    expect(readRegistrationForMove).not.toHaveBeenCalled()
  })
  it('404 when the entry does not exist', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    readRegistrationForMove.mockResolvedValue({ registration: null, error: null })
    expect((await POST(post(BODY), props())).status).toBe(404)
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('500 load_failed when the entry read fails (not a 404)', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    readRegistrationForMove.mockResolvedValue({ registration: null, error: { message: 'boom' } })
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: 'load_failed', message: 'The entry could not be read. Try again.' })
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('404 when the caller cannot see the source studio', async () => {
    getCurrentUser.mockResolvedValue(manager([L2]))
    expect((await POST(post(BODY), props())).status).toBe(404)
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('403 for a non-manager at the source studio', async () => {
    getCurrentUser.mockResolvedValue(manager([L1], 'staff'))
    expect((await POST(post(BODY), props())).status).toBe(403)
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('403 for a manager without races at the source studio', async () => {
    const u = manager([L1, L2])
    u.assignmentsByLocation[L1].permissions.races = false
    getCurrentUser.mockResolvedValue(u)
    expect((await POST(post(BODY), props())).status).toBe(403)
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('400 on a bad body', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await POST(post({ target_event_id: 'nope' }), props())).status).toBe(400)
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('404 when the target event does not exist', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    globalThis.__target = { data: null, error: null }
    expect((await POST(post(BODY), props())).status).toBe(404)
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('500 when the target event read fails (not a 404)', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    globalThis.__target = { data: null, error: { message: 'boom' } }
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: 'load_failed' })
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('404 when the caller cannot see the TARGET studio, before the lib runs', async () => {
    globalThis.__target = targetAt(L2)
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await POST(post(BODY), props())).status).toBe(404)
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('403 for a non-manager at the TARGET studio', async () => {
    globalThis.__target = targetAt(L2)
    const u = manager([L1, L2])
    u.rolesByLocation[L2] = 'staff'
    getCurrentUser.mockResolvedValue(u)
    expect((await POST(post(BODY), props())).status).toBe(403)
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('403 for a manager without races at the TARGET studio', async () => {
    globalThis.__target = targetAt(L2)
    const u = manager([L1, L2])
    u.assignmentsByLocation[L2].permissions.races = false
    getCurrentUser.mockResolvedValue(u)
    expect((await POST(post(BODY), props())).status).toBe(403)
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('404 when the lib answers not_found', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    moveRegistration.mockResolvedValue({ ok: false, error: 'not_found' })
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'not_found', message: 'That entry no longer exists.' })
  })
  it('409 with spots_left on wave_full', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    moveRegistration.mockResolvedValue({ ok: false, error: 'wave_full', spots_left: 0 })
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, error: 'wave_full', spots_left: 0, message: 'That time is full.' })
  })
  it('409 on conflict', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    moveRegistration.mockResolvedValue({ ok: false, error: 'conflict' })
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'conflict', message: expect.stringMatching(/changed while you were moving/) })
  })
  it.each(['load_failed', 'write_failed'])('500 on %s', async (code) => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    moveRegistration.mockResolvedValue({ ok: false, error: code })
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe(code)
    expect(json.message).toBeTruthy()
  })
  it('400 with the plain-English message on another rule', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    moveRegistration.mockResolvedValue({ ok: false, error: 'checked_in' })
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('checked_in')
    expect(json.message).toMatch(/already checked in/)
    expect(json).not.toHaveProperty('spots_left')
  })
  it('hands the lib the actor, force and note, and answers the move', async () => {
    getCurrentUser.mockResolvedValue(manager([L1, L2]))
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv1' }, registration: { id: R1 } })
    const res = await POST(post({ ...BODY, force: true, note: ' asked for Saturday ' }), props())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { move: { id: 'mv1' }, registration: { id: R1 } } })
    expect(moveRegistration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      registrationId: R1, targetEventId: E2, targetWaveId: W9, force: true, notify: true, note: 'asked for Saturday',
      actor: { type: 'staff', id: 'u1', name: 'Richard' },
    }))
    // The staff route never passes the host fence: the target studio is
    // judged by the route itself, from the target event's own row.
    expect(moveRegistration.mock.calls[0][1].allowedEventIds).toBeNull()
  })
  it('defaults notify to true, force to false, and a blank note to null', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv1' }, registration: { id: R1 } })
    await POST(post({ target_event_id: E2, note: '   ' }), props())
    expect(moveRegistration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      targetWaveId: null, notify: true, force: false, note: null,
    }))
  })
})
