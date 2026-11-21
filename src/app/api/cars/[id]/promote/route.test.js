// POST /api/cars/[id]/promote through the real withAuth wrapper: signed in
// (401), car_processing somewhere (403), the body, the car (404), its studio
// (404, never 403) and car_processing there (403), then the write.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const CAR_A = 'ca000000-0000-4000-8000-00000000000a'
const CAR_B = 'ca000000-0000-4000-8000-00000000000b'
const CARS_A = person({ [LOC_A]: { role: 'manager', permissions: { car_processing: true } } }, LOC_A)
const NO_CARS = person({ [LOC_A]: { role: 'manager', permissions: { car_processing: false } } }, LOC_A)
const promote = (id, to = 'pending') => POST(new Request(`http://localhost/api/cars/${id}/promote`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to }),
}), { params: Promise.resolve({ id }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    cars: [{ id: CAR_A, location_id: LOC_A, status: 'new' }, { id: CAR_B, location_id: LOC_B, status: 'new' }],
    car_documents: [],
  } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/cars/[id]/promote', () => {
  it('401 signed out, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await promote(CAR_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.cars[0].status).toBe('new')
  })

  it('403 without car_processing anywhere', async () => {
    getCurrentUser.mockResolvedValue(NO_CARS)
    const res = await promote(CAR_A)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
  })

  it('404 for another studio’s car, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(CARS_A)
    const res = await promote(CAR_B)
    expect(res.status).toBe(404)
    expect(db.tables.cars[1].status).toBe('new')
  })

  it('moves the caller’s own car to pending', async () => {
    getCurrentUser.mockResolvedValue(CARS_A)
    const res = await promote(CAR_A)
    expect(res.status).toBe(200)
    expect(db.tables.cars[0].status).toBe('pending')
  })

  it('a failed write answers a fixed 400, never the database text', async () => {
    getCurrentUser.mockResolvedValue(CARS_A)
    db.errors.cars = { update: { message: 'new row for relation "cars" violates check constraint' } }
    const res = await promote(CAR_A)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Could not move the car on. Refresh and try again.' })
  })
})
