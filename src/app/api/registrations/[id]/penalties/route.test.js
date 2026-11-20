// POST /api/registrations/[id]/penalties through the real withAuth wrapper.
// The checks keep their order: races somewhere 403, body 400, registration 404,
// its studio 404, races there 403, race-only 409.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const REG = 'ed000000-0000-4000-8000-000000000001'
const REG_FAR = 'ed000000-0000-4000-8000-000000000002'
const REG_WORKSHOP = 'ed000000-0000-4000-8000-000000000003'
const post = (id, body = { seconds: 30, reason: 'Missed a station' }) => POST(new Request(`http://localhost/api/registrations/${id}/penalties`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) })
const racesAt = (a, b) => person({ [LOC_A]: { role: 'manager', permissions: { races: a } }, [LOC_B]: { role: 'manager', permissions: { races: b } } }, LOC_A)
let db
const seed = (errors) => {
  db = createFakeDb({ tables: {
    race_events: [
      { id: 'ev-1', location_id: LOC_B, kind: 'race' },
      { id: 'ev-2', location_id: LOC_OTHER, kind: 'race' },
      { id: 'ev-3', location_id: LOC_B, kind: 'workshop' },
    ],
    race_registrations: [
      { id: REG, race_event_id: 'ev-1' }, { id: REG_FAR, race_event_id: 'ev-2' }, { id: REG_WORKSHOP, race_event_id: 'ev-3' },
    ],
    race_penalties: [],
  }, errors })
  createServerClient.mockReturnValue(db)
}

beforeEach(() => { vi.clearAllMocks(); seed() })

describe('POST /api/registrations/[id]/penalties', () => {
  it('401 signed out, nothing applied', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(REG)).status).toBe(401)
    expect(db.tables.race_penalties).toHaveLength(0)
  })

  it('403 without races at the registration\'s studio', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, false))
    expect((await post(REG)).status).toBe(403)
    expect(db.tables.race_penalties).toHaveLength(0)
  })

  it('404 for another studio\'s registration; 409 for a workshop', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    expect((await post(REG_FAR)).status).toBe(404)
    expect((await post(REG_WORKSHOP)).status).toBe(409)
    expect(db.tables.race_penalties).toHaveLength(0)
  })

  it('applies the penalty', async () => {
    getCurrentUser.mockResolvedValue(racesAt(false, true))
    const res = await post(REG)
    expect(res.status).toBe(201)
    expect((await res.json()).data).toMatchObject({ seconds: 30, reason: 'Missed a station', applied_by: 'user-1' })
  })

  it('a failed insert is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    seed({ race_penalties: { insert: { message: 'secret detail' } } })
    const res = await post(REG)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
