// UN1TRADAR.1 — the phone's radar glance returns a section as null while the
// location's provider lacks the memberships capability.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', async (importOriginal) => ({ ...(await importOriginal()), hasMobilePermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/radar-availability', () => ({ radarAvailability: vi.fn() }))
vi.mock('@/lib/churn-radar-data', () => ({ loadRadar: vi.fn(async () => ({ radar: [], summary: { activeBase: 3, overdueValueCents: 100 } })) }))

import { getCurrentUser } from '@/lib/auth'
import { radarAvailability } from '@/lib/radar-availability'
import { loadRadar } from '@/lib/churn-radar-data'
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
  })

  it('a Glofox studio gets the churn section; lead is always null (CONTACTLOG.2)', async () => {
    radarAvailability.mockResolvedValue({ available: true, source: 'glofox', dataAsOf: null })
    const body = await (await GET()).json()
    expect(body.data.churn.activeBase).toBe(3)
    expect(body.data.lead).toBeNull()
    expect(body.data.churn).not.toHaveProperty('overdueValueEstimated')
  })

  it('an unreadable source is a per-section error, as a failed load is today', async () => {
    radarAvailability.mockRejectedValue(new Error('membership source unreadable'))
    const body = await (await GET()).json()
    expect(body.data.churn).toBeNull()
    // The cause is logged; the phone gets a fixed flag (it shows its own copy).
    expect(body.data.churnError).toBe('fetch_failed')
    expect(body.data).not.toHaveProperty('leadError')
  })
})

describe('/api/mobile/radar estimate flag (UN1TRADAR.2)', () => {
  it('mobile radar carries overdueValueEstimated only when the summary has it', async () => {
    radarAvailability.mockResolvedValue({ available: true, source: 'un1t_online', dataAsOf: null })
    loadRadar.mockResolvedValueOnce({ radar: [], summary: { activeBase: 3, overdueValueCents: 12000, overdueValueEstimated: true } })
    const body = await (await GET()).json()
    expect(body.data.churn.overdueValueEstimated).toBe(true)
    loadRadar.mockResolvedValueOnce({ radar: [], summary: { activeBase: 3, overdueValueCents: 12000 } })
    const body2 = await (await GET()).json()
    expect(body2.data.churn).not.toHaveProperty('overdueValueEstimated')
  })
})
