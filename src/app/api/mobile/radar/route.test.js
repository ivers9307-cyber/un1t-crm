// GET /api/mobile/radar through the real withAuth wrapper: signed in (401),
// an active studio (400, 'No active location' with no full stop, as before),
// the MOBILE churn_radar permission (403 'Forbidden'), in that order.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/radar-availability', async (importOriginal) => ({ ...(await importOriginal()), radarAvailability: vi.fn(async () => ({ available: false })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { radarAvailability } = await import('@/lib/radar-availability')
const { GET } = await import('./route.js')

const RADAR_A = person({ [LOC_A]: { role: 'manager', permissions: { mobile: { churn_radar: true } } } }, LOC_A)
const NO_RADAR_A = person({ [LOC_A]: { role: 'staff', permissions: { mobile: { churn_radar: false } } } }, LOC_A)
const call = () => GET(new Request('http://localhost/api/mobile/radar'))

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/mobile/radar gate', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('400 without an active studio, before the permission', async () => {
    getCurrentUser.mockResolvedValue({ ...NO_RADAR_A, activeLocation: null })
    const res = await call()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'No active location' })
  })

  it('403 without the mobile churn_radar permission, nothing read', async () => {
    getCurrentUser.mockResolvedValue(NO_RADAR_A)
    const res = await call()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(radarAvailability).not.toHaveBeenCalled()
  })

  it('a caller with the permission gets the glance', async () => {
    getCurrentUser.mockResolvedValue(RADAR_A)
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { churn: null, lead: null } })
  })
})
