import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/contractor-invoices', () => ({
  computeScheduledForPeriod: vi.fn(async () => ({ scheduled_hours: 0, estimated_cost: 0, hourly_rate: 0 })),
}))

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { GET } from './route.js'

// db.from(t).select(c).eq(col,val).single() -> { data, error }
function mockDb(result) {
  const b = { from: () => b, select: () => b, eq: () => b, single: () => Promise.resolve(result) }
  return b
}

const INV = { id: 'inv1', contractor_id: 'c1', location_id: 'locA' }
const props = { params: Promise.resolve({ id: 'inv1' }) }

describe('GET /api/invoices/[id] — existence-leak guard + tiers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createServerClient.mockReturnValue(mockDb({ data: INV, error: null }))
  })

  // The fix: a non-self, non-owner-here, non-master caller gets 404 (was 403).
  it('404 (NOT 403) for a cross-org owner who is neither self nor owner-here', async () => {
    getCurrentUser.mockResolvedValue({ id: 'other', role: 'owner', rolesByLocation: { locB: 'owner' } })
    const res = await GET({}, props)
    expect(res.status).toBe(404)
  })

  // The self-contractor tier must be PRESERVED by the fix.
  it('self contractor still gets their own invoice (200, viewer_role=self)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c1', role: 'staff', rolesByLocation: {} })
    const res = await GET({}, props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.viewer_role).toBe('self')
  })

  it('owner at the invoice location gets it (200, viewer_role=owner)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'o1', role: 'owner', rolesByLocation: { locA: 'owner' } })
    const res = await GET({}, props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.viewer_role).toBe('owner')
  })
})
