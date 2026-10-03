// src/app/api/schedule/offers/[id]/route.test.js
// REPLACE.1b — a manager at the studio withdraws an open offer.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return { getCurrentUser: vi.fn(), assertLocationAccessOr404: real.assertLocationAccessOr404, hasRoleAtLocation: real.hasRoleAtLocation }
})
vi.mock('@/lib/shift-offer-server', () => ({ readOffer: vi.fn(), withdrawOffer: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { readOffer, withdrawOffer } = await import('@/lib/shift-offer-server')
const { DELETE } = await import('./route.js')

const OFFER_ID = '0ffe0000-0000-4000-8000-000000000001'
const MANAGER = { id: 'mgr', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' }, locations: [{ id: 'loc-1' }] }
const call = (id = OFFER_ID) => DELETE({ headers: { get: () => '' } }, { params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MANAGER)
  readOffer.mockResolvedValue({ offer: { id: OFFER_ID, location_id: 'loc-1', status: 'open' }, error: null })
  withdrawOffer.mockResolvedValue({ closed: true })
})

describe('DELETE /api/schedule/offers/[id]', () => {
  it('a manager at the studio withdraws an open offer', async () => {
    expect((await call()).status).toBe(200)
    expect(withdrawOffer).toHaveBeenCalledWith(expect.anything(), { offerId: OFFER_ID, nowIso: expect.any(String) })
  })
  it('401 signed out; 404 malformed, unknown, or outside the studio; 403 for staff there; 409 when it is no longer open', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await call()).status).toBe(401)
    getCurrentUser.mockResolvedValue(MANAGER)
    expect((await call('nope')).status).toBe(404)
    readOffer.mockResolvedValueOnce({ offer: null, error: null })
    expect((await call()).status).toBe(404)
    getCurrentUser.mockResolvedValue({ ...MANAGER, rolesByLocation: { 'loc-9': 'manager' }, locations: [{ id: 'loc-9' }] })
    expect((await call()).status).toBe(404)
    getCurrentUser.mockResolvedValue({ ...MANAGER, profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' } })
    expect((await call()).status).toBe(403)
    getCurrentUser.mockResolvedValue(MANAGER)
    readOffer.mockResolvedValue({ offer: { id: OFFER_ID, location_id: 'loc-1', status: 'claimed' }, error: null })
    expect((await call()).status).toBe(409)
    readOffer.mockResolvedValue({ offer: { id: OFFER_ID, location_id: 'loc-1', status: 'open' }, error: null })
    withdrawOffer.mockResolvedValue({ closed: false })
    expect((await call()).status).toBe(409)
    expect(withdrawOffer).toHaveBeenCalledTimes(1)
  })
  it('read or write failures are 500s', async () => {
    readOffer.mockResolvedValueOnce({ offer: null, error: { message: 'down' } })
    expect((await call()).status).toBe(500)
    withdrawOffer.mockResolvedValueOnce({ error: { message: 'down' } })
    expect((await call()).status).toBe(500)
  })
})
