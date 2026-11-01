// PIPE3.8 — /api/locations/[id]/pipeline-programmes: the Programmes board's
// entry rules (landing-page lead sources, Glofox trial plan names). Any member
// reads; only an owner or master AT the studio writes; the settings jsonb is
// merged through mergeLocationSettings, never clobbered.
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
const putReq = (body) => new Request('http://x/api/locations/loc1/pipeline-programmes', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const getReq = () => new Request('http://x/api/locations/loc1/pipeline-programmes')

const owner = {
  id: 'u', role: 'owner', profileRole: 'owner', isMaster: false,
  activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }], rolesByLocation: { loc1: 'owner' },
}
const withRole = (role) => ({ ...owner, role, profileRole: role, rolesByLocation: { loc1: role } })
const SEEDED = { pipelines: { programmes: { lead_sources: ['meta_50plus'], glofox_plan_patterns: ['elites trial'] } } }

function mockDb(existingSettings = {}, { boards = [{ id: 'p-prog' }] } = {}) {
  let written = null
  const locationRow = () => Promise.resolve({ data: { id: 'loc1', settings: existingSettings }, error: null })
  createServerClient.mockReturnValue({
    from: (table) => ({
      select: () => {
        const q = {
          eq: () => q,
          limit: () => Promise.resolve({ data: boards, error: null }),
          maybeSingle: () => (table === 'locations' ? locationRow() : Promise.resolve({ data: null, error: null })),
          single: locationRow,
        }
        return q
      },
      update: (patch) => {
        written = patch
        return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1' }, error: null }) }) }) }
      },
    }),
  })
  return () => written
}

describe('GET', () => {
  it('a member reads the lists and whether the studio has a Programmes board; can_edit false for staff', async () => {
    getCurrentUser.mockResolvedValue(withRole('staff'))
    mockDb(SEEDED)
    const res = await GET(getReq(), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ has_board: true, lead_sources: ['meta_50plus'], glofox_plan_patterns: ['elites trial'], can_edit: false })
  })
  it('a studio with no Programmes board says so, with empty lists', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb({}, { boards: [] })
    expect((await (await GET(getReq(), props)).json()).data).toEqual({ has_board: false, lead_sources: [], glofox_plan_patterns: [], can_edit: true })
  })
  it('a non-member is refused', async () => {
    getCurrentUser.mockResolvedValue({ ...owner, locations: [{ id: 'other' }], rolesByLocation: { other: 'owner' }, activeLocation: { id: 'other' } })
    mockDb(SEEDED)
    expect((await GET(getReq(), props)).status).toBe(403)
  })
})

describe('PUT', () => {
  it('a manager is refused', async () => {
    getCurrentUser.mockResolvedValue(withRole('manager'))
    const written = mockDb(SEEDED)
    expect((await PUT(putReq({ lead_sources: ['x'], glofox_plan_patterns: [] }), props)).status).toBe(403)
    expect(written()).toBeNull()
  })
  it('an owner stores both lists lower-cased and trimmed, keeping sibling settings', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const written = mockDb({ glofox: { branch_id: 'x' }, pipelines: { other: 1, programmes: { lead_sources: ['meta_50plus'], glofox_plan_patterns: ['elites trial'] } } })
    const res = await PUT(putReq({ lead_sources: [' META_50plus ', 'meta_postnatal'], glofox_plan_patterns: ['Elites Trial'] }), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ has_board: true, lead_sources: ['meta_50plus', 'meta_postnatal'], glofox_plan_patterns: ['elites trial'], can_edit: true })
    expect(written().settings).toEqual({
      glofox: { branch_id: 'x' },
      pipelines: { other: 1, programmes: { lead_sources: ['meta_50plus', 'meta_postnatal'], glofox_plan_patterns: ['elites trial'] } },
    })
  })
  it('more than 20 entries, or a blank entry, is a 400 and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const written = mockDb(SEEDED)
    expect((await PUT(putReq({ lead_sources: Array.from({ length: 21 }, (_, i) => `s${i}`), glofox_plan_patterns: [] }), props)).status).toBe(400)
    expect((await PUT(putReq({ lead_sources: ['  '], glofox_plan_patterns: [] }), props)).status).toBe(400)
    expect(written()).toBeNull()
  })
  it('a master at the studio may write', async () => {
    getCurrentUser.mockResolvedValue({ ...owner, role: 'master', profileRole: 'master', isMaster: true })
    mockDb(SEEDED)
    expect((await PUT(putReq({ lead_sources: ['meta_50plus'], glofox_plan_patterns: [] }), props)).status).toBe(200)
  })
})
