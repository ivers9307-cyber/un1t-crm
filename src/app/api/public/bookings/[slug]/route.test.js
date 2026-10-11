// W1.S1b — the public booking-type payload carries the studio's brand, so the
// BookingWidget's marketing consent names the gym the person is booking with
// rather than a literal.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: () => '1.2.3.4',
  rateLimitResponse: () => new Response('limited', { status: 429 }),
}))
vi.mock('@/lib/host-brand', () => ({
  resolveLocationBrand: vi.fn(async ({ locationId }) => ({ companyName: locationId === 'loc-a' ? 'Gym A North' : '', shortName: '', locationName: '' })),
}))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { resolveLocationBrand } from '@/lib/host-brand'

function dbReturning(row) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    single: async () => (row ? { data: row, error: null } : { data: null, error: { message: 'none' } }),
  }
  return { from: () => builder }
}

const call = (slug) => GET(new Request(`https://crm.test/api/public/bookings/${slug}`), { params: Promise.resolve({ slug }) })

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/public/bookings/[slug] — brand (W1.S1b)', () => {
  it('adds the booking type\'s studio brand from the per-location cache', async () => {
    createServerClient.mockReturnValue(dbReturning({ id: 'et-1', slug: 'consult', location_id: 'loc-a', locations: { id: 'loc-a', name: 'North' } }))
    const body = await (await call('consult')).json()
    expect(body.success).toBe(true)
    expect(body.data.brand).toBe('Gym A North')
    expect(resolveLocationBrand).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc-a' }))
  })

  it('a missing booking type is a 404 and resolves no brand', async () => {
    createServerClient.mockReturnValue(dbReturning(null))
    const res = await call('nope')
    expect(res.status).toBe(404)
    expect(resolveLocationBrand).not.toHaveBeenCalled()
  })
})
