// POST /api/events/[id]/checkin/scan through the real withAuth wrapper (a staff
// session; the QR token is judged inside): signed in (withAuth's 401), races
// somewhere (403), the token, the event's studio (404 outside), races there
// (403); then one race_checkins row.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/contact-events', async (importOriginal) => ({ ...(await importOriginal()), emitEvent: vi.fn(async () => ({})) }))
vi.mock('@/lib/event-checkin-tokens', async (importOriginal) => ({ ...(await importOriginal()), verifyCheckinToken: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { verifyCheckinToken } = await import('@/lib/event-checkin-tokens')
const { POST } = await import('./route.js')

const EV_B = 'e0000000-0000-4000-8000-0000000000b3'
const EV_FAR = 'e0000000-0000-4000-8000-0000000000f3'
const TEAM_B = 'c1000000-0000-4000-8000-0000000000b3'
const TEAM_FAR = 'c1000000-0000-4000-8000-0000000000f3'
const REG_B = 'a0000000-0000-4000-8000-0000000000b3'
const REG_FAR = 'a0000000-0000-4000-8000-0000000000f3'
const MEM_B = 'c2000000-0000-4000-8000-0000000000b3'
const MEM_FAR = 'c2000000-0000-4000-8000-0000000000f3'
const scan = (eventId) => POST(new Request(`http://localhost/api/events/${eventId}/checkin/scan`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'qr-token' }),
}), { params: Promise.resolve({ id: eventId }) })
const racesAt = (a, b) => person({ [LOC_A]: { role: 'manager', permissions: { races: a } }, [LOC_B]: { role: 'manager', permissions: { races: b } } }, LOC_A)
const tokenFor = (eventId, registrationId, memberId) => verifyCheckinToken.mockReturnValue({ eventId, registrationId, memberId })

let db
const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY
beforeEach(() => {
  vi.clearAllMocks()
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret'
  db = createFakeDb({ tables: {
    race_events: [{ id: EV_B, location_id: LOC_B }, { id: EV_FAR, location_id: LOC_OTHER }],
    teams: [{ id: TEAM_B, location_id: LOC_B }, { id: TEAM_FAR, location_id: LOC_OTHER }],
    team_members: [{ id: MEM_B, team_id: TEAM_B, name: 'Runner B', email: null, contact_id: null }, { id: MEM_FAR, team_id: TEAM_FAR, name: 'Runner F', email: null, contact_id: null }],
    race_registrations: [
      { id: REG_B, race_event_id: EV_B, status: 'confirmed', contact_id: null, placed_into_registration_id: null, team_id: TEAM_B },
      { id: REG_FAR, race_event_id: EV_FAR, status: 'confirmed', contact_id: null, placed_into_registration_id: null, team_id: TEAM_FAR },
    ],
    race_checkins: [],
  } })
  createServerClient.mockReturnValue(db)
  tokenFor(EV_B, REG_B, MEM_B)
})
afterEach(() => { process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey })

describe('POST /api/events/[id]/checkin/scan', () => {
  it('401 signed out (withAuth; was "Unauthorised")', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await scan(EV_B)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 without races anywhere', async () => {
    getCurrentUser.mockResolvedValue(racesAt(false, false))
    expect((await scan(EV_B)).status).toBe(403)
  })

  it("404 for another studio's event, nothing written", async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    tokenFor(EV_FAR, REG_FAR, MEM_FAR)
    expect((await scan(EV_FAR)).status).toBe(404)
    expect(db.tables.race_checkins).toEqual([])
  })

  it("403 without races at the event's studio", async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, false))
    expect((await scan(EV_B)).status).toBe(403)
    expect(db.tables.race_checkins).toEqual([])
  })

  it('checks the attendee in', async () => {
    getCurrentUser.mockResolvedValue(racesAt(false, true))
    const res = await scan(EV_B)
    expect(res.status).toBe(200)
    expect((await res.json()).data.checked_in).toBe(true)
    expect(db.tables.race_checkins).toHaveLength(1)
    expect(db.tables.race_checkins[0]).toMatchObject({ race_registration_id: REG_B, team_member_id: MEM_B, location_id: LOC_B })
  })

  it('a failed insert is a 400 without the database text', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    db.errors.race_checkins = { insert: { message: 'secret db text' } }
    const res = await scan(EV_B)
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('secret db text')
  })
})
