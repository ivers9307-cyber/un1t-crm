// POST /api/registrations/[id]/race-start through the real withAuth wrapper:
// signed in (withAuth's 401), races somewhere (403), the race's studio (404
// outside), races there (403); then the start stamp.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const EV_B = 'e0000000-0000-4000-8000-0000000000b2'
const EV_FAR = 'e0000000-0000-4000-8000-0000000000f2'
const REG_B = 'a0000000-0000-4000-8000-0000000000b2'
const REG_FAR = 'a0000000-0000-4000-8000-0000000000f2'
const start = (id) => POST(new Request(`http://localhost/api/registrations/${id}/race-start`, { method: 'POST' }), { params: Promise.resolve({ id }) })
const racesAt = (a, b) => person({ [LOC_A]: { role: 'manager', permissions: { races: a } }, [LOC_B]: { role: 'manager', permissions: { races: b } } }, LOC_A)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    race_events: [{ id: EV_B, location_id: LOC_B, kind: 'race' }, { id: EV_FAR, location_id: LOC_OTHER, kind: 'race' }],
    race_registrations: [
      { id: REG_B, race_event_id: EV_B, status: 'confirmed', race_started_at: null, race_finished_at: null },
      { id: REG_FAR, race_event_id: EV_FAR, status: 'confirmed', race_started_at: null, race_finished_at: null },
    ],
  } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/registrations/[id]/race-start', () => {
  it('401 signed out (withAuth; was "Unauthorised")', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await start(REG_B)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 without races anywhere', async () => {
    getCurrentUser.mockResolvedValue(racesAt(false, false))
    expect((await start(REG_B)).status).toBe(403)
  })

  it("404 for another studio's registration, nothing stamped", async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    expect((await start(REG_FAR)).status).toBe(404)
    expect(db.tables.race_registrations.find((r) => r.id === REG_FAR).race_started_at).toBeNull()
  })

  it("403 without races at the race's studio", async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, false))
    expect((await start(REG_B)).status).toBe(403)
  })

  it('stamps the start', async () => {
    getCurrentUser.mockResolvedValue(racesAt(false, true))
    const res = await start(REG_B)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(db.tables.race_registrations.find((r) => r.id === REG_B).race_started_at).toBe(body.race_started_at)
  })

  it('a failed write is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    db.errors.race_registrations = { update: { message: 'secret db text' } }
    const res = await start(REG_B)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret db text')
  })
})
