// GET/POST /api/cars/[id]/notes through the real withAuth wrapper: signed in,
// car_processing somewhere, the car's studio (404 outside), car_processing
// there; then the notes at that car, and a new one stamped with its studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, POST } = await import('./route.js')

const CAR = 'ca000000-0000-4000-8000-000000000011'
const CAR_FAR = 'ca000000-0000-4000-8000-000000000012'
const props = (id) => ({ params: Promise.resolve({ id }) })
const get = (id) => GET(new Request(`http://localhost/api/cars/${id}/notes`), props(id))
const post = (id, body) => POST(new Request(`http://localhost/api/cars/${id}/notes`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), props(id))
const carsAt = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { car_processing: a } }, [LOC_B]: { role: 'owner', permissions: { car_processing: b } } }, LOC_A)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    cars: [{ id: CAR, location_id: LOC_B }, { id: CAR_FAR, location_id: LOC_OTHER }],
    car_notes: [{ id: 'n1', car_id: CAR, location_id: LOC_B, content: 'Arrived', kind: 'manual', created_by: null, created_at: '2026-11-01T10:00:00Z' }],
    profiles: [],
  } })
  createServerClient.mockReturnValue(db)
})

describe('/api/cars/[id]/notes', () => {
  it('401 signed out (withAuth), nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get(CAR)).status).toBe(401)
    expect((await post(CAR, { content: 'x' })).status).toBe(401)
    expect(db.tables.car_notes).toHaveLength(1)
  })

  it('403 without car_processing anywhere', async () => {
    getCurrentUser.mockResolvedValue(carsAt(false, false))
    expect((await get(CAR)).status).toBe(403)
  })

  it('404 for another studio\'s car', async () => {
    getCurrentUser.mockResolvedValue(carsAt(true, true))
    expect((await get(CAR_FAR)).status).toBe(404)
    expect((await post(CAR_FAR, { content: 'x' })).status).toBe(404)
    expect(db.tables.car_notes).toHaveLength(1)
  })

  it('403 without car_processing at the car\'s studio', async () => {
    getCurrentUser.mockResolvedValue(carsAt(true, false))
    expect((await post(CAR, { content: 'x' })).status).toBe(403)
  })

  it('lists the car\'s notes and adds one at the car\'s studio', async () => {
    getCurrentUser.mockResolvedValue(carsAt(false, true))
    const list = await get(CAR)
    expect(list.status).toBe(200)
    expect((await list.json()).notes.map((n) => n.id)).toEqual(['n1'])
    const res = await post(CAR, { content: '  Booked NCT  ' })
    expect(res.status).toBe(200)
    expect(db.tables.car_notes.at(-1)).toMatchObject({ car_id: CAR, location_id: LOC_B, content: 'Booked NCT', kind: 'manual', created_by: 'user-1' })
  })
})
