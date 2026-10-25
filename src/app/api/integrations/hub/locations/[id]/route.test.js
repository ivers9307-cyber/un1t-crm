// INTEGONE.1 — GET /api/integrations/hub/locations/[id], the hub drawer's
// per-location context. Service role, so these gates are the boundary:
//   no session                          → 401
//   not a member of the location        → 404 (never 403: ids are not probed)
//   member but not owner here / master  → 404
//   owner here, master, org-admin synth → 200 with the context
// and the payload: the shaped location (no credential value), a failed Xero
// read reported as xeroReadFailed (never "not connected"), the viewer flags.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/membership/source', () => ({
  membershipSourceState: vi.fn(async () => ({ source: 'glofox', state: 'configured' })),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const OTHER = 'a0000000-0000-4000-8000-000000000002'
const ORG = 'b0000000-0000-4000-8000-000000000001'

const ROW = {
  id: LOC,
  name: 'Stillorgan',
  organization_id: ORG,
  features: { bca_submit: true },
  membership_source: 'glofox',
  sensibo_api_key: 'SENSIBO_SECRET',
  thinq_pat: 'THINQ_SECRET',
  settings: { glofox: { branch_id: 'br-1', api_key: 'GLOFOX_SECRET_KEY', api_token: 'GLOFOX_SECRET_TOKEN' } },
  bca_config: { send_from: 'vat@ccf.example' },
}

const XERO = { location_id: LOC, tenant_id: 't-1', tenant_name: 'Champ Fitness Ltd' }
const CAR = { uk_reg: 'AB12 CDE', make: 'Ford' }

// Answers per table; records each table's select string and filters.
function fakeDb(byTable = {}) {
  const calls = {}
  return {
    calls,
    from(table) {
      const rec = (calls[table] ||= { selects: [], eq: [], in: [] })
      const result = byTable[table] ?? { data: null, error: null }
      const builder = {
        select: (cols, opts) => { rec.selects.push([cols, opts]); return builder },
        eq: (...a) => { rec.eq.push(a); return builder },
        in: (...a) => { rec.in.push(a); return builder },
        order: () => builder,
        limit: () => builder,
        single: async () => result,
        maybeSingle: async () => result,
        then: (res, rej) => Promise.resolve(result).then(res, rej),
      }
      return builder
    },
  }
}

const params = (id = LOC) => ({ params: Promise.resolve({ id }) })
const ownerHere = { id: 'u1', role: 'owner', profileRole: 'staff', rolesByLocation: { [LOC]: 'owner' }, locations: [{ id: LOC, organization_id: ORG }], orgAdminOrgIds: [] }

function defaultDb(over = {}) {
  return fakeDb({
    locations: { data: ROW, error: null },
    xero_connections: { data: XERO, error: null },
    cars: { data: CAR, error: null },
    channel_connections: { count: 1, error: null },
    ...over,
  })
}

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/integrations/hub/locations/[id] — gates', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('404 (not 403) for a location the caller is not a member of, before any read', async () => {
    getCurrentUser.mockResolvedValue(ownerHere)
    const res = await GET(new Request('http://x'), params(OTHER))
    expect(res.status).toBe(404)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('404 for a member who is not owner at THIS location (a manager here, owner elsewhere)', async () => {
    getCurrentUser.mockResolvedValue({
      ...ownerHere,
      role: 'owner',
      rolesByLocation: { [LOC]: 'manager', [OTHER]: 'owner' },
      locations: [{ id: LOC, organization_id: ORG }, { id: OTHER, organization_id: ORG }],
    })
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(404)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('200 for an owner here, a master, and an org admin with the synthetic owner role', async () => {
    const users = [
      ownerHere,
      { id: 'm', role: 'master', profileRole: 'master', isMaster: true, rolesByLocation: {}, locations: [{ id: LOC, organization_id: ORG }] },
      // SAAS-4: getCurrentUser gives an org admin 'owner' where they hold no membership.
      { id: 'oa', role: 'owner', profileRole: 'staff', rolesByLocation: { [LOC]: 'owner' }, locations: [{ id: LOC, organization_id: ORG }], orgAdminOrgIds: [ORG] },
    ]
    for (const u of users) {
      getCurrentUser.mockResolvedValue(u)
      createServerClient.mockReturnValue(defaultDb())
      const res = await GET(new Request('http://x'), params())
      expect(res.status).toBe(200)
    }
  })
})

describe('GET /api/integrations/hub/locations/[id] — payload', () => {
  it('returns the page context: shaped location, Xero row, sample car, membership source, un1t flag, viewer', async () => {
    getCurrentUser.mockResolvedValue(ownerHere)
    const db = defaultDb()
    createServerClient.mockReturnValue(db)
    const res = await GET(new Request('http://x'), params())
    const body = await res.json()
    expect(body.success).toBe(true)
    const d = body.data
    expect(d.location.id).toBe(LOC)
    expect(d.location.has_sensibo_key).toBe(true)
    expect(d.location.has_thinq_pat).toBe(true)
    expect(d.location.bca_config).toEqual({ send_from: 'vat@ccf.example' })
    expect(d.xeroConnection).toEqual(XERO)
    expect(d.xeroReadFailed).toBe(false)
    expect(d.sampleBcaCar).toEqual(CAR)
    expect(d.membershipSource).toEqual({ source: 'glofox', state: 'configured' })
    expect(d.hasUn1tOnlineConnection).toBe(true)
    expect(d.viewer).toEqual({
      isMaster: false, isOwnerOrMaster: true, ownsWhatsAppHere: true, canSwitchWhatsApp: true, canManageNumbers: false,
    })
    // Every read keys off the path location.
    expect(db.calls.locations.eq).toEqual([['id', LOC]])
    expect(db.calls.xero_connections.eq).toEqual([['location_id', LOC]])
    expect(db.calls.cars.eq).toEqual([['location_id', LOC]])
    expect(db.calls.channel_connections.eq).toEqual(expect.arrayContaining([['location_id', LOC], ['platform', 'un1t_online'], ['is_active', true]]))
  })

  it('carries no credential value anywhere in the payload', async () => {
    getCurrentUser.mockResolvedValue(ownerHere)
    createServerClient.mockReturnValue(defaultDb())
    const text = JSON.stringify(await (await GET(new Request('http://x'), params())).json())
    for (const secret of ['SENSIBO_SECRET', 'THINQ_SECRET', 'GLOFOX_SECRET_KEY', 'GLOFOX_SECRET_TOKEN']) {
      expect(text).not.toContain(secret)
    }
  })

  it('a failed Xero read is xeroReadFailed: true, never "not connected", and is logged', async () => {
    getCurrentUser.mockResolvedValue(ownerHere)
    createServerClient.mockReturnValue(defaultDb({ xero_connections: { data: null, error: { message: 'db exploded' } } }))
    const body = await (await GET(new Request('http://x'), params())).json()
    expect(body.success).toBe(true)
    expect(body.data.xeroReadFailed).toBe(true)
    expect(body.data.xeroConnection).toBeNull()
    expect(logError).toHaveBeenCalledWith('integrations-hub-location', 'xero_connections read failed', expect.objectContaining({ locationId: LOC }))
  })

  it('a failed un1t.online count keeps the tab reachable (true); a clean zero is false', async () => {
    getCurrentUser.mockResolvedValue(ownerHere)
    createServerClient.mockReturnValue(defaultDb({ channel_connections: { count: null, error: { code: '57014' } } }))
    expect((await (await GET(new Request('http://x'), params())).json()).data.hasUn1tOnlineConnection).toBe(true)
    createServerClient.mockReturnValue(defaultDb({ channel_connections: { count: 0, error: null } }))
    expect((await (await GET(new Request('http://x'), params())).json()).data.hasUn1tOnlineConnection).toBe(false)
  })

  it('no sample car read unless BCA Submit is on at the location', async () => {
    getCurrentUser.mockResolvedValue(ownerHere)
    const db = defaultDb({ locations: { data: { ...ROW, features: {} }, error: null } })
    createServerClient.mockReturnValue(db)
    const body = await (await GET(new Request('http://x'), params())).json()
    expect(body.data.sampleBcaCar).toBeNull()
    expect(db.calls.cars).toBeUndefined()
  })

  it('a failed location read is a 500 (not 404), and no-such-row is a 404', async () => {
    getCurrentUser.mockResolvedValue(ownerHere)
    createServerClient.mockReturnValue(defaultDb({ locations: { data: null, error: { code: 'XX000', message: 'boom' } } }))
    expect((await GET(new Request('http://x'), params())).status).toBe(500)
    createServerClient.mockReturnValue(defaultDb({ locations: { data: null, error: { code: 'PGRST116', message: 'no rows' } } }))
    expect((await GET(new Request('http://x'), params())).status).toBe(404)
  })
})
