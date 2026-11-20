// SEC-LIVE-API.1 — GET /api/live/[locationId] through the real withAuth
// wrapper (ROUTEWRAP.R6): signed in, a member of the URL's studio, holding
// studio_management there (guardLiveLocation's 403s, unchanged).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/live-class', async (importOriginal) => ({ ...(await importOriginal()), getLiveSessions: vi.fn(async () => []), getAvailableStraps: vi.fn(async () => []) }))
vi.mock('@/lib/class-bookings', async (importOriginal) => ({ ...(await importOriginal()), getClassRoster: vi.fn(async () => ({ occurrence: null, roster: [] })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const get = (loc = LOC_A) => GET(new Request(`http://localhost/api/live/${loc}`), { params: Promise.resolve({ locationId: loc }) })
const coach = (studio = true) => person({ [LOC_A]: { role: 'head_coach', permissions: { studio_management: studio } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { ble_bridges: [{ id: 'b0000000-0000-4000-8000-000000000001', location_id: LOC_A, test_mode_until: null }] } }))
})

describe('GET /api/live/[locationId]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it("403 for a studio outside the caller's", async () => {
    getCurrentUser.mockResolvedValue(coach())
    expect((await get(LOC_B)).status).toBe(403)
  })

  it('403 without studio_management at the studio', async () => {
    getCurrentUser.mockResolvedValue(coach(false))
    const res = await get()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Studio management permission required')
  })

  it('a coach with studio_management gets the board', async () => {
    getCurrentUser.mockResolvedValue(coach())
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, sessions: [], roster: [], has_bridge: true, test_mode_until: null })
  })
})
