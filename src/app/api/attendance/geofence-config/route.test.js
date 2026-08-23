// src/app/api/attendance/geofence-config/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { DEFAULT_GATE_COPY } from '@/lib/geofence-attendance'

beforeEach(() => vi.clearAllMocks())

const req = () => new Request('http://x/api/attendance/geofence-config')
const staff = { id: 'prof-1', role: 'staff', activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }] }

const GEO = { enabled: true, latitude: 53.2905, longitude: -6.1988, radius_m: 200 }

// profile_locations rows + locations rows behind one from() switch.
// `in()` is faithful to the real query filter — it narrows `locs` to the
// ids the route actually passed, so a route regression that narrows the
// query back to eligible-only ids is caught by the tests below instead of
// silently returning every fixture location regardless of what was asked for.
function mockDb({ links, locs }) {
  const inStub = (_col, ids) => ({
    order: () => Promise.resolve({ data: (locs || []).filter(l => ids.includes(l.id)), error: null }),
  })
  createServerClient.mockReturnValue({
    from: (table) => ({
      select: () => ({
        eq: () => table === 'profile_locations'
          ? Promise.resolve({ data: links, error: null })
          : { in: inStub },
        in: inStub,
      }),
    }),
  })
}

describe('GET /api/attendance/geofence-config', () => {
  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req())).status).toBe(401)
  })

  it('required=true with a region for an enabled, non-exempt assignment', async () => {
    getCurrentUser.mockResolvedValue(staff)
    mockDb({
      links: [{ location_id: 'loc1', geofence_exempt: false }],
      locs: [{ id: 'loc1', settings: { geofence: GEO } }],
    })
    const body = await (await GET(req())).json()
    expect(body.success).toBe(true)
    expect(body.data.required).toBe(true)
    expect(body.data.regions).toEqual([
      { location_id: 'loc1', latitude: 53.2905, longitude: -6.1988, radius_m: 200 },
    ])
    expect(body.data.gate_copy).toBe(DEFAULT_GATE_COPY)
  })

  it('required=false when exempt', async () => {
    getCurrentUser.mockResolvedValue(staff)
    mockDb({
      links: [{ location_id: 'loc1', geofence_exempt: true }],
      locs: [{ id: 'loc1', settings: { geofence: GEO } }],
    })
    const body = await (await GET(req())).json()
    expect(body.data.required).toBe(false)
    expect(body.data.regions).toEqual([])
  })

  it('required=false when the location blob is disabled or missing coords', async () => {
    getCurrentUser.mockResolvedValue(staff)
    mockDb({
      links: [{ location_id: 'loc1', geofence_exempt: false }],
      locs: [{ id: 'loc1', settings: { geofence: { ...GEO, enabled: false } } }],
    })
    expect((await (await GET(req())).json()).data.required).toBe(false)
  })

  it('includes exempt locations in all_regions but not regions', async () => {
    getCurrentUser.mockResolvedValue(staff)
    mockDb({
      links: [
        { location_id: 'locA', geofence_exempt: false },
        { location_id: 'locB', geofence_exempt: true },
      ],
      locs: [
        { id: 'locA', settings: { geofence: GEO } },
        { id: 'locB', settings: { geofence: GEO } },
      ],
    })
    const body = await (await GET(req())).json()
    expect(body.data.regions.map(r => r.location_id)).toEqual(['locA'])
    expect(body.data.all_regions.map(r => r.location_id).sort()).toEqual(['locA', 'locB'])
    expect(body.data.required).toBe(true) // still driven by non-exempt regions only
  })

  it('all-exempt user gets all_regions but required:false and empty regions', async () => {
    getCurrentUser.mockResolvedValue(staff)
    mockDb({
      links: [{ location_id: 'locA', geofence_exempt: true }],
      locs: [{ id: 'locA', settings: { geofence: GEO } }],
    })
    const body = await (await GET(req())).json()
    expect(body.data.regions).toEqual([])
    expect(body.data.required).toBe(false)
    expect(body.data.all_regions.map(r => r.location_id)).toEqual(['locA'])
  })
})
