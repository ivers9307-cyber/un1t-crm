// GET /api/events/[id]/control-board through the real withAuth wrapper:
// signed in, races somewhere, the race's studio (404 outside), races there.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

let db
let regError
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
const { getCurrentUser } = await import('@/lib/auth')
const { GET } = await import('./route.js')

const EV = 'e0000000-0000-4000-8000-000000000011'
const EV_FAR = 'e0000000-0000-4000-8000-000000000012'
const get = (id) => GET(new Request(`http://localhost/api/events/${id}/control-board`), { params: Promise.resolve({ id }) })
const racesAt = (a, b) => person({ [LOC_A]: { role: 'manager', permissions: { races: a } }, [LOC_B]: { role: 'manager', permissions: { races: b } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  regError = null
  db = fakeDb((q) => {
    if (q.table === 'race_events') {
      const id = q.ops.find((o) => o[0] === 'eq' && o[1] === 'id')?.[2]
      const loc = id === EV ? LOC_B : id === EV_FAR ? LOC_OTHER : null
      return loc ? { data: { id, location_id: loc, kind: 'race', waves: [] }, error: null } : { data: null, error: { code: 'PGRST116' } }
    }
    if (q.table === 'race_registrations') return regError ? { data: null, error: regError } : { data: [{ id: 'r1', status: 'confirmed' }], error: null }
    return { data: null, error: null }
  })
})

describe('GET /api/events/[id]/control-board — gate', () => {
  it('401 signed out (withAuth)', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get(EV)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 without races anywhere', async () => {
    getCurrentUser.mockResolvedValue(racesAt(false, false))
    expect((await get(EV)).status).toBe(403)
  })

  it('404 for another studio\'s race', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    expect((await get(EV_FAR)).status).toBe(404)
  })

  it('403 without races at the race\'s studio, though held at the active one', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, false))
    expect((await get(EV)).status).toBe(403)
  })

  it('the board for races at the race\'s studio only', async () => {
    getCurrentUser.mockResolvedValue(racesAt(false, true))
    const res = await get(EV)
    expect(res.status).toBe(200)
    expect((await res.json()).registrations.map((r) => r.id)).toEqual(['r1'])
  })

  it('a failed registrations read is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    regError = { message: 'column race_registrations.secret does not exist' }
    const res = await get(EV)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not load the registrations.' })
  })
})
