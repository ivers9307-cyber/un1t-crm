import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET, PUT } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { DEFAULT_GATE_COPY } from '@/lib/geofence-attendance'

beforeEach(() => vi.clearAllMocks())

// Next 16 handler props — `await props.params` works on a plain object.
const props = { params: { id: 'loc1' } }

function putReq(body) {
  return new Request('http://x/api/locations/loc1/geofence-attendance', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
const getReq = () => new Request('http://x/api/locations/loc1/geofence-attendance')

// assertLocationAccess reads user.locations.
const owner = { id: 'u', role: 'owner', activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }] }

const validBody = {
  enabled: true,
  latitude: 53.2905,
  longitude: -6.1988,
  radius_m: 200,
  gate_copy: null,
}

// Locations row select + captured merge-write, scoring-test style.
function mockDb(existingSettings = {}) {
  let written = null
  createServerClient.mockReturnValue({
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: 'loc1', settings: existingSettings }, error: null }) }) }),
      update: (patch) => {
        written = patch
        return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1', settings: patch.settings }, error: null }) }) }) }
      },
    }),
  })
  return () => written
}

describe('GET /api/locations/[id]/geofence-attendance', () => {
  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq(), props)).status).toBe(401)
  })

  it('returns the defaulted blob for empty settings (can_edit for owner)', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb({})
    const body = await (await GET(getReq(), props)).json()
    expect(body.success).toBe(true)
    expect(body.data).toEqual({
      enabled: false,
      latitude: null,
      longitude: null,
      radius_m: 150,
      gate_copy: DEFAULT_GATE_COPY,
      can_edit: true,
    })
  })

  it('can_edit=false for a manager (read still allowed)', async () => {
    getCurrentUser.mockResolvedValue({ ...owner, role: 'manager' })
    mockDb({})
    const body = await (await GET(getReq(), props)).json()
    expect(body.success).toBe(true)
    expect(body.data.can_edit).toBe(false)
  })
})

describe('PUT /api/locations/[id]/geofence-attendance — auth gate', () => {
  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(putReq(validBody), props)).status).toBe(401)
  })

  it.each(['staff', 'head_coach', 'manager'])('403 for %s (owner + master only)', async (role) => {
    getCurrentUser.mockResolvedValue({ ...owner, role })
    expect((await PUT(putReq(validBody), props)).status).toBe(403)
  })

  it('200 for an owner', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb()
    expect((await PUT(putReq(validBody), props)).status).toBe(200)
  })
})

describe('PUT /api/locations/[id]/geofence-attendance — merge write', () => {
  it('writes settings.geofence without clobbering sibling settings keys', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const getWritten = mockDb({ unifi: { host: 'x' } })
    const res = await PUT(putReq(validBody), props)
    expect(res.status).toBe(200)
    const written = getWritten()
    // sibling survives the merge
    expect(written.settings.unifi).toEqual({ host: 'x' })
    // and the geofence blob is stored exactly
    expect(written.settings.geofence).toEqual({
      enabled: true,
      latitude: 53.2905,
      longitude: -6.1988,
      radius_m: 200,
      gate_copy: null,
    })
  })

  it('echoes the normalised saved state', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb()
    const body = await (await PUT(putReq(validBody), props)).json()
    expect(body.success).toBe(true)
    expect(body.data.enabled).toBe(true)
    expect(body.data.latitude).toBe(53.2905)
    expect(body.data.radius_m).toBe(200)
    // null gate_copy → the default copy comes back
    expect(body.data.gate_copy).toBe(DEFAULT_GATE_COPY)
  })
})

describe('PUT /api/locations/[id]/geofence-attendance — Zod rejection', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb()
  })

  it('400 on latitude 91 (out of range)', async () => {
    expect((await PUT(putReq({ ...validBody, latitude: 91 }), props)).status).toBe(400)
  })

  it('400 on longitude 181 (out of range)', async () => {
    expect((await PUT(putReq({ ...validBody, longitude: 181 }), props)).status).toBe(400)
  })

  it('400 on radius 20 (below the 50 m floor)', async () => {
    expect((await PUT(putReq({ ...validBody, radius_m: 20 }), props)).status).toBe(400)
  })

  it('400 when enabled without coordinates (refine)', async () => {
    expect((await PUT(putReq({ ...validBody, latitude: null }), props)).status).toBe(400)
  })

  it('disabled with null coordinates is fine', async () => {
    expect((await PUT(putReq({ enabled: false, latitude: null, longitude: null, radius_m: 150, gate_copy: null }), props)).status).toBe(200)
  })
})
