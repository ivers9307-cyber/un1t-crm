// GET /api/cars/[id]/xero-contact-search through the real withAuth wrapper:
// car_processing somewhere, the car, its studio (404 outside), the key there.
// A Xero failure keeps its status but answers a fixed line.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/xero/client', async (importOriginal) => ({ ...(await importOriginal()), withFreshToken: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { withFreshToken, XeroError } = await import('@/lib/xero/client')
const { GET } = await import('./route.js')

const CAR = 'f1000000-0000-4000-8000-000000000001'
const CAR_FAR = 'f1000000-0000-4000-8000-000000000002'
const get = (id, q = 'smith') => GET(new Request(`http://localhost/api/cars/${id}/xero-contact-search?q=${q}`), { params: Promise.resolve({ id }) })
const keyAt = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { car_processing: a } }, [LOC_B]: { role: 'owner', permissions: { car_processing: b } } }, LOC_A)
let xfetch

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { cars: [{ id: CAR, location_id: LOC_B }, { id: CAR_FAR, location_id: LOC_OTHER }] } }))
  xfetch = vi.fn(async () => ({ Contacts: [{ ContactID: 'x-1', Name: 'Sam Smith', EmailAddress: null }] }))
  withFreshToken.mockResolvedValue({ xfetch })
})

describe('GET /api/cars/[id]/xero-contact-search', () => {
  it('401 signed out, Xero never asked', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get(CAR)).status).toBe(401)
    expect(withFreshToken).not.toHaveBeenCalled()
  })

  it('403 "Not permitted" without car_processing at the car\'s studio', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, false))
    const res = await get(CAR)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Not permitted' })
    expect(withFreshToken).not.toHaveBeenCalled()
  })

  it('404 for another studio\'s car', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, true))
    expect((await get(CAR_FAR)).status).toBe(404)
    expect(withFreshToken).not.toHaveBeenCalled()
  })

  it('searches the car\'s studio\'s Xero org', async () => {
    getCurrentUser.mockResolvedValue(keyAt(false, true))
    const res = await get(CAR)
    expect(res.status).toBe(200)
    expect((await res.json()).contacts).toEqual([{ id: 'x-1', name: 'Sam Smith', email: null, phone: null, address: null }])
    expect(withFreshToken).toHaveBeenCalledWith(LOC_B)
  })

  it('a Xero failure keeps its status without Xero\'s text', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, true))
    xfetch.mockRejectedValueOnce(new XeroError('secret detail', { status: 429 }))
    const res = await get(CAR)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ success: false, error: 'Xero lookup failed' })
  })
})
