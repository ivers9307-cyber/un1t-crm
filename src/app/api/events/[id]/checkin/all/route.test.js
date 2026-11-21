// POST /api/events/[id]/checkin/all through the real withAuth wrapper: races
// somewhere, body, the registration on this event, its studio (404 outside),
// races there; then one check-in row per team member.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/contact-events', async (importOriginal) => ({ ...(await importOriginal()), emitEvent: vi.fn(async () => {}) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const EV = 'eb000000-0000-4000-8000-000000000001'
const EV_FAR = 'eb000000-0000-4000-8000-000000000002'
const REG = 'eb000000-0000-4000-8000-000000000011'
const REG_FAR = 'eb000000-0000-4000-8000-000000000012'
const TEAM = 'eb000000-0000-4000-8000-000000000021'
const post = (eventId, regId) => POST(new Request(`http://localhost/api/events/${eventId}/checkin/all`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ race_registration_id: regId }),
}), { params: Promise.resolve({ id: eventId }) })
const racesAt = (a, b) => person({ [LOC_A]: { role: 'manager', permissions: { races: a } }, [LOC_B]: { role: 'manager', permissions: { races: b } } }, LOC_A)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    race_events: [{ id: EV, location_id: LOC_B }, { id: EV_FAR, location_id: LOC_OTHER }],
    teams: [{ id: TEAM, location_id: LOC_B, name: 'Team' }],
    team_members: [{ id: 'tm-1', team_id: TEAM, name: 'A', email: null }, { id: 'tm-2', team_id: TEAM, name: 'B', email: null }],
    race_registrations: [{ id: REG, race_event_id: EV, team_id: TEAM }, { id: REG_FAR, race_event_id: EV_FAR, team_id: null }],
    race_checkins: [],
  } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/events/[id]/checkin/all', () => {
  it('401 signed out, nobody checked in', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(EV, REG)).status).toBe(401)
    expect(db.tables.race_checkins).toHaveLength(0)
  })

  it('403 without races at the event\'s studio, though held at the active one', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, false))
    expect((await post(EV, REG)).status).toBe(403)
    expect(db.tables.race_checkins).toHaveLength(0)
  })

  it('404 for another studio\'s registration', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    expect((await post(EV_FAR, REG_FAR)).status).toBe(404)
  })

  it('checks the whole team in at the event\'s studio', async () => {
    getCurrentUser.mockResolvedValue(racesAt(false, true))
    const res = await post(EV, REG)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { checked_in: 2 } })
    expect(db.tables.race_checkins.map((r) => r.location_id)).toEqual([LOC_B, LOC_B])
  })
})
