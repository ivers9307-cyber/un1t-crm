// LIEU.1 — /api/locations/[id]/payroll: any member reads the Sunday lieu
// multiplier (effective + whether it is the default); only an owner or master
// AT the studio writes it; the settings jsonb is merged, never clobbered; null
// clears the override.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET, PUT } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => vi.clearAllMocks())

const props = { params: { id: 'loc1' } }
const putReq = (body) => new Request('http://x/api/locations/loc1/payroll', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const getReq = () => new Request('http://x/api/locations/loc1/payroll')

const owner = {
  id: 'u', role: 'owner', profileRole: 'owner', isMaster: false,
  activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }], rolesByLocation: { loc1: 'owner' },
}
const withRole = (role) => ({ ...owner, role, profileRole: role, rolesByLocation: { loc1: role } })

function mockDb(existingSettings = {}, { missing = false } = {}) {
  let written = null
  const row = () => Promise.resolve(missing
    ? { data: null, error: { code: 'PGRST116', message: 'no row' } }
    : { data: { id: 'loc1', settings: existingSettings }, error: null })
  createServerClient.mockReturnValue({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => (missing ? Promise.resolve({ data: null, error: null }) : row()), single: row }) }),
      update: (patch) => {
        written = patch
        return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1' }, error: null }) }) }) }
      },
    }),
  })
  return () => written
}

describe('GET', () => {
  it('a member reads the effective rule; the default is flagged', async () => {
    getCurrentUser.mockResolvedValue(withRole('staff'))
    mockDb({ geofence: { enabled: true } })
    const json = await (await GET(getReq(), props)).json()
    expect(json.data).toEqual({ sunday_multiplier: 1.3333, default_sunday_multiplier: 1.3333, is_default: true, min: 1, max: 3, can_edit: false })
  })
  it('a stored override is reported with can_edit for an owner', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb({ payroll: { sunday_multiplier: 1.5 } })
    const json = await (await GET(getReq(), props)).json()
    expect(json.data).toMatchObject({ sunday_multiplier: 1.5, is_default: false, can_edit: true })
  })
  it('a non-member is 403, a missing studio 404', async () => {
    getCurrentUser.mockResolvedValue({ ...owner, locations: [{ id: 'other' }], rolesByLocation: { other: 'owner' } })
    mockDb()
    expect((await GET(getReq(), props)).status).toBe(403)
    getCurrentUser.mockResolvedValue(owner)
    mockDb({}, { missing: true })
    expect((await GET(getReq(), props)).status).toBe(404)
  })
})

describe('PUT', () => {
  it('an owner writes the multiplier, merging sibling settings keys', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const written = mockDb({ geofence: { enabled: true }, payroll: { other: 'kept' } })
    const res = await PUT(putReq({ sunday_multiplier: 1.5 }), props)
    expect(res.status).toBe(200)
    expect(written().settings).toEqual({ geofence: { enabled: true }, payroll: { other: 'kept', sunday_multiplier: 1.5 } })
    expect((await res.json()).data).toMatchObject({ sunday_multiplier: 1.5, is_default: false, can_edit: true })
  })
  it('null clears the override (back to the default)', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const written = mockDb({ payroll: { sunday_multiplier: 1.5 } })
    const res = await PUT(putReq({ sunday_multiplier: null }), props)
    expect(written().settings).toEqual({ payroll: {} })
    expect((await res.json()).data).toMatchObject({ sunday_multiplier: 1.3333, is_default: true })
  })
  it('a manager or head coach is 403; a master may write', async () => {
    for (const role of ['manager', 'head_coach', 'staff']) {
      getCurrentUser.mockResolvedValue(withRole(role))
      const written = mockDb()
      expect((await PUT(putReq({ sunday_multiplier: 1.5 }), props)).status).toBe(403)
      expect(written()).toBeNull()
    }
    getCurrentUser.mockResolvedValue({ ...owner, role: 'master', profileRole: 'master', isMaster: true, rolesByLocation: {} })
    mockDb()
    expect((await PUT(putReq({ sunday_multiplier: 2 }), props)).status).toBe(200)
  })
  it('out-of-range or non-numeric values are 400', async () => {
    getCurrentUser.mockResolvedValue(owner)
    for (const bad of [{ sunday_multiplier: 0.5 }, { sunday_multiplier: 4 }, { sunday_multiplier: '1.5' }, {}]) {
      const written = mockDb()
      expect((await PUT(putReq(bad), props)).status).toBe(400)
      expect(written()).toBeNull()
    }
  })
})
