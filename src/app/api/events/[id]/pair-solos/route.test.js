// FINDTEAM.5 — POST /api/events/[id]/pair-solos. The rules live in
// src/lib/registration-placement.test.js; this pins the gate, the schema, the
// error mapping and the placed email kick-off.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => {
  const b = {
    select: (cols) => { globalThis.__selects.push(cols); return b }, eq: () => b,
    maybeSingle: async () => globalThis.__event,
  }
  return { createServerClient: vi.fn(() => ({ from: (t) => { globalThis.__tables.push(t); return b } })) }
})
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/registration-placement', async (importOriginal) => ({ ...(await importOriginal()), pairSolos: vi.fn() }))
vi.mock('@/lib/race-confirmations', () => ({ sendPlacedEmail: vi.fn(async () => ({ sent: ['email'], skipped: [], failed: [] })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { pairSolos } = await import('@/lib/registration-placement')
const { sendPlacedEmail } = await import('@/lib/race-confirmations')
const { POST } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const L2 = 'a0000000-0000-0000-0000-000000000002'
const E1 = 'e0000000-0000-0000-0000-000000000001'
const W1 = 'f0000000-0000-0000-0000-000000000001'
const id = (n) => `c0000000-0000-0000-0000-00000000000${n}`
const NEW_REG = 'd0000000-0000-0000-0000-000000000001'
const manager = (locs, role = 'manager', races = true) => ({
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role, profileRole: role,
  activeLocation: { id: locs[0] },
  rolesByLocation: Object.fromEntries(locs.map((l) => [l, role])),
  assignmentsByLocation: Object.fromEntries(locs.map((l) => [l, { role, permissions: { races } }])),
  locations: locs.map((loc) => ({ id: loc, role, features: { races: true } })),
})
const props = (eventId = E1) => ({ params: Promise.resolve({ id: eventId }) })
const post = (body) => new Request(`http://localhost/api/events/${E1}/pair-solos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const BODY = { registration_ids: [id(1), id(2)], team_name: 'Team Solo' }
const eventAt = (location_id) => ({ data: { id: E1, location_id }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.__event = eventAt(L1)
  globalThis.__selects = []
  globalThis.__tables = []
  pairSolos.mockResolvedValue({ ok: true, registrationId: NEW_REG, placedIds: [id(1), id(2)] })
})

describe('POST /api/events/[id]/pair-solos — gate', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(post(BODY), props())).status).toBe(401)
  })
  it('403 for a caller holding races nowhere', async () => {
    getCurrentUser.mockResolvedValue(manager([L1], 'manager', false))
    expect((await POST(post(BODY), props())).status).toBe(403)
    expect(pairSolos).not.toHaveBeenCalled()
  })
  it('404 for an id that is not uuid-shaped', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await POST(post(BODY), props('nope'))).status).toBe(404)
    expect(globalThis.__tables).toEqual([])
  })
  it('404 for an unknown event', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    globalThis.__event = { data: null, error: null }
    expect((await POST(post(BODY), props())).status).toBe(404)
    expect(pairSolos).not.toHaveBeenCalled()
  })
  it('500 load_failed when the event read fails', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    globalThis.__event = { data: null, error: { message: 'boom' } }
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: 'load_failed' })
  })
  it('404 when the caller cannot see the event\'s studio', async () => {
    getCurrentUser.mockResolvedValue(manager([L2]))
    expect((await POST(post(BODY), props())).status).toBe(404)
    expect(pairSolos).not.toHaveBeenCalled()
  })
  it('403 for a non-manager at the event\'s studio', async () => {
    getCurrentUser.mockResolvedValue(manager([L1], 'staff'))
    expect((await POST(post(BODY), props())).status).toBe(403)
    expect(pairSolos).not.toHaveBeenCalled()
  })
  it('never reads race_events.find_team', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    await POST(post(BODY), props())
    expect(globalThis.__selects.join(' ')).not.toMatch(/find_team/)
  })
})

describe('POST /api/events/[id]/pair-solos — body', () => {
  it.each([
    ['one id', { ...BODY, registration_ids: [id(1)] }],
    ['nine ids', { ...BODY, registration_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `c0000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`) }],
    ['a bad id', { ...BODY, registration_ids: [id(1), 'nope'] }],
    ['an empty team name', { ...BODY, team_name: '   ' }],
    ['an 81-character team name', { ...BODY, team_name: 'x'.repeat(81) }],
    ['a bad wave id', { ...BODY, wave_id: 'nope' }],
  ])('400 for %s', async (_label, body) => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await POST(post(body), props())).status).toBe(400)
    expect(pairSolos).not.toHaveBeenCalled()
  })
  it('accepts 8 ids, an 80-character name, a wave and force', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => id(n))
    const res = await POST(post({ registration_ids: ids, team_name: 'x'.repeat(80), wave_id: W1, force: true }), props())
    expect(res.status).toBe(200)
    expect(pairSolos).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      raceEventId: E1, registrationIds: ids, teamName: 'x'.repeat(80), waveId: W1, force: true, byProfileId: 'u1',
    }))
  })
  it('defaults wave to null and force to false', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    await POST(post(BODY), props())
    expect(pairSolos.mock.calls[0][1]).toMatchObject({ waveId: null, force: false, teamName: 'Team Solo' })
  })
})

describe('POST /api/events/[id]/pair-solos — outcome', () => {
  it('answers { registration_id } and emails each placed person', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { registration_id: NEW_REG } })
    expect(sendPlacedEmail.mock.calls.map((c) => c[0].registrationId)).toEqual([id(1), id(2)])
  })
  it('a rejected email never changes the response', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    sendPlacedEmail.mockRejectedValue(new Error('postmark down'))
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { registration_id: NEW_REG } })
  })
  it('409 wave_full carries code and spots_left, no email', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    pairSolos.mockResolvedValue({ ok: false, error: 'wave_full', spots_left: 0 })
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, error: 'wave_full', code: 'wave_full', spots_left: 0 })
    expect(sendPlacedEmail).not.toHaveBeenCalled()
  })
  it('a partial flip failure is 500 and still emails the people who were placed', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    pairSolos.mockResolvedValue({ ok: false, error: 'write_failed', stage: 'status_flip', registrationId: NEW_REG, ids: [id(2)], placedIds: [id(1)] })
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: 'write_failed', registration_id: NEW_REG, ids: [id(2)] })
    expect(sendPlacedEmail.mock.calls.map((c) => c[0].registrationId)).toEqual([id(1)])
  })
  it.each([
    ['mixed_waves', 400], ['too_few', 400], ['invalid_wave', 400],
    ['not_paid', 409], ['already_placed', 409], ['not_solo', 409], ['team_name_taken', 409],
    ['not_found', 404], ['load_failed', 500],
  ])('%s → %i, with a message', async (code, status) => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    pairSolos.mockResolvedValue({ ok: false, error: code })
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(status)
    const json = await res.json()
    expect(json).toMatchObject({ success: false, error: code })
    expect(json.message).toMatch(/\S/)
    expect(sendPlacedEmail).not.toHaveBeenCalled()
  })
})
