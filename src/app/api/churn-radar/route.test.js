// CHURN-RADAR.1 — GET /api/churn-radar through the real withAuth wrapper:
// churn_radar at the active studio, the radar read for that studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A } from '../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/radar-cache', () => ({ radarCache: vi.fn((_k, _l, _s, fn) => fn()), invalidateRadar: vi.fn() }))
vi.mock('@/lib/radar-availability', async (importOriginal) => ({ ...(await importOriginal()), radarAvailability: vi.fn() }))
vi.mock('@/lib/churn-radar-data', () => ({ loadRadar: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { radarAvailability } = await import('@/lib/radar-availability')
const { loadRadar } = await import('@/lib/churn-radar-data')
const { GET } = await import('./route.js')

const radar = (on) => person({ [LOC_A]: { role: 'owner', permissions: { churn_radar: on } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  radarAvailability.mockResolvedValue({ available: true, source: 'glofox', dataAsOf: null })
  loadRadar.mockResolvedValue({ members: [], summary: {} })
})

describe('GET /api/churn-radar', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(new Request('http://localhost/api/churn-radar'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Forbidden" without churn_radar, nothing read', async () => {
    getCurrentUser.mockResolvedValue(radar(false))
    const res = await GET(new Request('http://localhost/api/churn-radar'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(loadRadar).not.toHaveBeenCalled()
  })

  it('reads the radar for the active studio', async () => {
    getCurrentUser.mockResolvedValue(radar(true))
    const res = await GET(new Request('http://localhost/api/churn-radar'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, data: { members: [], summary: {} }, source: 'glofox' })
    expect(loadRadar).toHaveBeenCalledWith({ tag: 'db' }, LOC_A)
  })

  it('a failed read is a 500 without the error text', async () => {
    getCurrentUser.mockResolvedValue(radar(true))
    loadRadar.mockRejectedValue(new Error('secret detail'))
    const res = await GET(new Request('http://localhost/api/churn-radar'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'fetch_failed' })
  })
})
