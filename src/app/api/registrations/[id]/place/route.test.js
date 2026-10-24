// FINDTEAM.5 — POST /api/registrations/[id]/place. The rules live in
// src/lib/registration-placement.test.js; this pins the gate, the schema, the
// error mapping and the placed email kick-off.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The route reads the solo (id + its event's studio) to judge the studio.
vi.mock('@/lib/supabase', () => {
  const b = {
    select: (cols) => { globalThis.__selects.push(cols); return b }, eq: () => b,
    maybeSingle: async () => globalThis.__solo,
  }
  return { createServerClient: vi.fn(() => ({ from: (t) => { globalThis.__tables.push(t); return b } })) }
})
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/registration-placement', async (importOriginal) => ({ ...(await importOriginal()), placeSoloIntoTeam: vi.fn() }))
vi.mock('@/lib/race-confirmations', () => ({ sendPlacedEmail: vi.fn(async () => ({ sent: ['email'], skipped: [], failed: [] })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { placeSoloIntoTeam } = await import('@/lib/registration-placement')
const { sendPlacedEmail } = await import('@/lib/race-confirmations')
const { POST } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const L2 = 'a0000000-0000-0000-0000-000000000002'
const E1 = 'e0000000-0000-0000-0000-000000000001'
const SOLO = 'c0000000-0000-0000-0000-000000000001'
const TEAM = 'c0000000-0000-0000-0000-000000000002'
const manager = (locs, role = 'manager', races = true) => ({
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role, profileRole: role,
  activeLocation: { id: locs[0] },
  rolesByLocation: Object.fromEntries(locs.map((l) => [l, role])),
  assignmentsByLocation: Object.fromEntries(locs.map((l) => [l, { role, permissions: { races } }])),
  locations: locs.map((id) => ({ id, role, features: { races: true } })),
})
const props = (id = SOLO) => ({ params: Promise.resolve({ id }) })
const post = (body) => new Request(`http://localhost/api/registrations/${SOLO}/place`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const BODY = { team_registration_id: TEAM }
const soloAt = (location_id) => ({ data: { id: SOLO, race_event_id: E1, race: { id: E1, location_id } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.__solo = soloAt(L1)
  globalThis.__selects = []
  globalThis.__tables = []
  placeSoloIntoTeam.mockResolvedValue({ ok: true })
})

describe('POST /api/registrations/[id]/place — gate', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(post(BODY), props())).status).toBe(401)
  })
  it('403 for a caller holding races nowhere', async () => {
    getCurrentUser.mockResolvedValue(manager([L1], 'manager', false))
    expect((await POST(post(BODY), props())).status).toBe(403)
    expect(placeSoloIntoTeam).not.toHaveBeenCalled()
  })
  it('404 for an id that is not uuid-shaped', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await POST(post(BODY), props('nope'))).status).toBe(404)
    expect(globalThis.__tables).toEqual([])
  })
  it('404 for an unknown registration', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    globalThis.__solo = { data: null, error: null }
    expect((await POST(post(BODY), props())).status).toBe(404)
    expect(placeSoloIntoTeam).not.toHaveBeenCalled()
  })
  it('500 load_failed when the read fails (not a 404)', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    globalThis.__solo = { data: null, error: { message: 'boom' } }
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: 'load_failed' })
  })
  it('404 when the caller cannot see the event\'s studio', async () => {
    getCurrentUser.mockResolvedValue(manager([L2]))
    expect((await POST(post(BODY), props())).status).toBe(404)
    expect(placeSoloIntoTeam).not.toHaveBeenCalled()
  })
  it('403 for a non-manager at the event\'s studio', async () => {
    getCurrentUser.mockResolvedValue(manager([L1], 'staff'))
    expect((await POST(post(BODY), props())).status).toBe(403)
    expect(placeSoloIntoTeam).not.toHaveBeenCalled()
  })
  it('403 for a manager without races at the event\'s studio', async () => {
    const u = manager([L1, L2])
    u.assignmentsByLocation[L1].permissions.races = false
    getCurrentUser.mockResolvedValue(u)
    expect((await POST(post(BODY), props())).status).toBe(403)
  })
  it('400 on a bad body', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await POST(post({ team_registration_id: 'nope' }), props())).status).toBe(400)
    expect((await POST(post({}), props())).status).toBe(400)
    expect(placeSoloIntoTeam).not.toHaveBeenCalled()
  })
  it('never reads race_events.find_team', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    await POST(post(BODY), props())
    expect(globalThis.__selects.join(' ')).not.toMatch(/find_team/)
  })
})

describe('POST /api/registrations/[id]/place — outcome', () => {
  it('places, answers { placed: true }, and emails the placed person', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { placed: true } })
    expect(placeSoloIntoTeam).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      soloRegistrationId: SOLO, teamRegistrationId: TEAM, byProfileId: 'u1',
    }))
    expect(sendPlacedEmail).toHaveBeenCalledTimes(1)
    expect(sendPlacedEmail).toHaveBeenCalledWith(expect.objectContaining({ registrationId: SOLO }))
  })
  it('records the real master under impersonation', async () => {
    getCurrentUser.mockResolvedValue({ ...manager([L1]), impersonatingFrom: { masterId: 'master-1' } })
    await POST(post(BODY), props())
    expect(placeSoloIntoTeam.mock.calls[0][1].byProfileId).toBe('master-1')
  })
  it('a rejected email never changes the response', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    sendPlacedEmail.mockRejectedValueOnce(new Error('postmark down'))
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { placed: true } })
  })
  it.each([
    ['not_paid', 409], ['already_placed', 409], ['not_solo', 409], ['target_not_live', 409],
    ['not_found', 404], ['wrong_event', 404], ['write_failed', 500], ['load_failed', 500],
  ])('%s → %i, with a message and no email', async (code, status) => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    placeSoloIntoTeam.mockResolvedValue({ ok: false, error: code })
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(status)
    const json = await res.json()
    expect(json).toMatchObject({ success: false, error: code })
    expect(json.message).toMatch(/\S/)
    expect(sendPlacedEmail).not.toHaveBeenCalled()
  })
})
