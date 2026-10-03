// PAGEGATES.1 — /cars/[id] decides at the CAR's location.
//
// Every /api/cars/[id]/** route judges `car_processing` at the car's
// location. The page judged it at the ACTIVE studio: a member without the
// permission at the car's studio got the car rendered with every control
// 403ing, and an outsider was redirected instead of 404'd. (The cars layout
// still gates the whole /cars tree at the active studio; widening it is a
// separate decision, since the list pages lean on it.)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, MASTER, LOC_A, LOC_B } from '../../../../tests/helpers/role-sweep-callers.js'
import { pageDb, navigationMock } from '../../../../tests/helpers/page-db-mock.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => navigationMock())
vi.mock('@/lib/fx', () => ({ getCachedGbpToEur: vi.fn(async () => null) }))
vi.mock('@/components/cars/CarDetail', () => ({ default: () => null }))

import CarDetailPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const CAR_ID = 'ca000000-0000-4000-8000-000000000001'
const props = () => ({ params: Promise.resolve({ id: CAR_ID }) })
const at = (loc) => createServerClient.mockReturnValue(pageDb({
  cars: { id: CAR_ID, location_id: loc, car_documents: [] },
  locations: { features: {} },
  car_bca_submissions: [],
}))
const key = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { car_processing: a } }, [LOC_B]: { role: 'owner', permissions: { car_processing: b } } }, LOC_A)

beforeEach(() => vi.clearAllMocks())

describe('/cars/[id]', () => {
  it('opens for `car_processing` at the car\'s studio only (main: redirected by the page)', async () => {
    getCurrentUser.mockResolvedValue(key(false, true)); at(LOC_B)
    await expect(CarDetailPage(props())).resolves.toBeTruthy()
  })
  it('refuses `car_processing` at the active studio only (main: rendered the car; every control 403s)', async () => {
    getCurrentUser.mockResolvedValue(key(true, false)); at(LOC_B)
    await expect(CarDetailPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
  it('404s an outsider (main: redirected)', async () => {
    // An owner with car_processing at their own studio, who does not belong to B.
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: { car_processing: true } } }, LOC_A)); at(LOC_B)
    await expect(CarDetailPage(props())).rejects.toThrow(/^NEXT_NOT_FOUND$/)
  })
  it('opens for a master', async () => {
    getCurrentUser.mockResolvedValue(MASTER); at(LOC_B)
    await expect(CarDetailPage(props())).resolves.toBeTruthy()
  })
})
