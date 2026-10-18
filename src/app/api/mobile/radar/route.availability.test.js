// UN1TRADAR.1 — the phone's radar glance returns a section as null while the
// location's provider lacks the memberships capability.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasMobilePermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/radar-availability', () => ({ radarAvailability: vi.fn() }))
vi.mock('@/lib/churn-radar-data', () => ({ loadRadar: vi.fn(async () => ({ radar: [], summary: { activeBase: 3, overdueValueCents: 100 } })) }))
vi.mock('@/lib/lead-radar-data', () => ({ loadFunnel: vi.fn(async () => ({ funnel: [], summary: { funnelTotal: 2 } })) }))

import { getCurrentUser } from '@/lib/auth'
import { radarAvailability } from '@/lib/radar-availability'
import { loadRadar } from '@/lib/churn-radar-data'
import { loadFunnel } from '@/lib/lead-radar-data'
import { GET } from './route'

const L = 'loc-1'
beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', activeLocation: { id: L } })
})

describe('/api/mobile/radar availability', () => {
  it('mobile radar returns churn:null and lead:null at a source without memberships', async () => {
    radarAvailability.mockResolvedValue({ available: false, source: 'un1t_online', dataAsOf: null })
    const body = await (await GET()).json()
    expect(body).toEqual({ success: true, data: { churn: null, lead: null } })
    expect(loadRadar).not.toHaveBeenCalled()
    expect(loadFunnel).not.toHaveBeenCalled()
  })

  it('a Glofox studio still gets both sections', async () => {
    radarAvailability.mockResolvedValue({ available: true, source: 'glofox', dataAsOf: null })
    const body = await (await GET()).json()
    expect(body.data.churn.activeBase).toBe(3)
    expect(body.data.lead.funnelTotal).toBe(2)
    expect(body.data.churn).not.toHaveProperty('overdueValueEstimated')
  })

  it('an unreadable source is a per-section error, as a failed load is today', async () => {
    radarAvailability.mockRejectedValue(new Error('membership source unreadable'))
    const body = await (await GET()).json()
    expect(body.data.churn).toBeNull()
    expect(body.data.churnError).toBe('membership source unreadable')
    expect(body.data.leadError).toBe('membership source unreadable')
  })
})
