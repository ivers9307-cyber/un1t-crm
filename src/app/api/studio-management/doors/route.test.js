// src/app/api/studio-management/doors/route.test.js
// WIDGET.1 — characterisation net written BEFORE rewiring this route to
// call the extracted listAllowedDoors() helper (src/lib/studio-doors.js).
// Pins the route's observable output — `data`, `scope`, and every status
// code — so the extraction cannot silently change behaviour.
//
// UniFi client seam: getUnifiConfig + listDoors (src/lib/unifi-access.js)
// — stubbed here over the real module so `UnifiError` stays a real class
// (the route branches on `e instanceof UnifiError`).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/widget-auth', () => ({ getWidgetUser: vi.fn() }))
vi.mock('@/lib/unifi-access', async () => {
  const actual = await vi.importActual('@/lib/unifi-access')
  return { ...actual, getUnifiConfig: vi.fn(), listDoors: vi.fn() }
})

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getWidgetUser } from '@/lib/widget-auth'
import { getUnifiConfig, listDoors, UnifiError } from '@/lib/unifi-access'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const LOCATION_ROW = { id: LOC, name: 'Stillorgan', settings: {} }
const CFG = { configured: true, host: 'unifi.test', apiToken: 't' }

const manager = { id: 'u1', role: 'manager', activeLocation: { id: LOC } }

function getReq() {
  return new Request('https://x.test/api/studio-management/doors', { method: 'GET' })
}

// Configurable fake DB. Tables: profile_locations (the UNIFI-DOORS-SCOPE
// allowlist read), locations (name + settings for the config dual-read).
function mockDb({ assignment = { unifi_door_ids: null }, location = LOCATION_ROW } = {}) {
  const db = {
    from: (table) => {
      if (table === 'profile_locations') return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () =>
          Promise.resolve({ data: assignment, error: null }) }) }) }),
      }
      if (table === 'locations') return {
        select: () => ({ eq: () => ({ single: () =>
          Promise.resolve({ data: location, error: null }) }) }),
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  createServerClient.mockReturnValue(db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  getWidgetUser.mockResolvedValue(null)
  mockDb()
  getUnifiConfig.mockResolvedValue(CFG)
})

describe('GET /api/studio-management/doors — preserved behaviour', () => {
  it('404s when the location row is missing', async () => {
    getCurrentUser.mockResolvedValue(manager)
    mockDb({ location: null })
    const res = await GET(getReq())
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body).toEqual({ success: false, error: 'Location not found.' })
    expect(listDoors).not.toHaveBeenCalled()
  })

  it('412s with code unifi_not_configured when the location has no UniFi config', async () => {
    getCurrentUser.mockResolvedValue(manager)
    getUnifiConfig.mockResolvedValue({ configured: false })
    const res = await GET(getReq())
    const body = await res.json()
    expect(res.status).toBe(412)
    expect(body).toEqual({
      success: false,
      error: 'UniFi Access is not fully configured for this location. Ask a master to fill in the controller settings under Settings → Locations.',
      code: 'unifi_not_configured',
    })
    expect(listDoors).not.toHaveBeenCalled()
  })

  it('passes through a UnifiError\'s own status', async () => {
    getCurrentUser.mockResolvedValue(manager)
    listDoors.mockRejectedValue(new UnifiError('Controller offline', { status: 504 }))
    const res = await GET(getReq())
    const body = await res.json()
    expect(res.status).toBe(504)
    expect(body).toEqual({ success: false, error: 'Controller offline' })
  })

  it('502s on a non-UniFiError failure', async () => {
    getCurrentUser.mockResolvedValue(manager)
    listDoors.mockRejectedValue(new Error('boom'))
    const res = await GET(getReq())
    const body = await res.json()
    expect(res.status).toBe(502)
    expect(body).toEqual({ success: false, error: 'UniFi request failed: boom' })
  })

  it('returns every door with scope unrestricted for a NULL allowlist', async () => {
    getCurrentUser.mockResolvedValue(manager)
    listDoors.mockResolvedValue([{ id: 'd1', name: 'Front' }, { id: 'd2', name: 'Back' }])
    mockDb({ assignment: { unifi_door_ids: null } })
    const res = await GET(getReq())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({
      success: true,
      data: [{ id: 'd1', name: 'Front' }, { id: 'd2', name: 'Back' }],
      scope: 'unrestricted',
    })
  })

  it('returns only the allowlist intersection with scope allowlist', async () => {
    getCurrentUser.mockResolvedValue(manager)
    listDoors.mockResolvedValue([
      { id: 'd1', name: 'Front' },
      { id: 'd2', name: 'Back' },
      { id: 'd3', name: 'Side' },
    ])
    mockDb({ assignment: { unifi_door_ids: ['d1', 'd3'] } })
    const res = await GET(getReq())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({
      success: true,
      data: [{ id: 'd1', name: 'Front' }, { id: 'd3', name: 'Side' }],
      scope: 'allowlist',
    })
  })

  it('returns zero doors with scope allowlist for an empty allowlist', async () => {
    getCurrentUser.mockResolvedValue(manager)
    listDoors.mockResolvedValue([{ id: 'd1', name: 'Front' }])
    mockDb({ assignment: { unifi_door_ids: [] } })
    const res = await GET(getReq())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: [], scope: 'allowlist' })
  })
})
