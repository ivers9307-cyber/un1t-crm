// INTEG-D2 — /api/admin/tenants route matrix (roster, drill-in,
// wallet-adjust). Auth is mocked at getCurrentUser (the routes' own
// master gate is what's under test); the roster/detail assemblers are
// mocked (their pure parts are covered in src/lib/admin-tenants.test.js);
// wallet-adjust runs the REAL applyWalletEntry against a fake db whose
// rpc we control — pinning that the ONE write on the console goes
// through the wallet_apply RPC with kind='adjustment' and the acting
// master as created_by.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'

let db
let currentUser

vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => currentUser) }))
vi.mock('@/lib/admin-tenants', () => ({
  getTenantsRoster: vi.fn(),
  getTenantDetail: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))

import { getTenantsRoster, getTenantDetail } from '@/lib/admin-tenants'
import { logAuditEvent } from '@/lib/audit'
import { GET } from './route.js'
import { GET as GET_DETAIL } from './[orgId]/route.js'
import { POST as POST_ADJUST } from './wallet-adjust/route.js'

const ORG_ID = 'a0000000-0000-0000-0000-0000000000aa'
const LOC_ID = 'b0000000-0000-0000-0000-0000000000bb'
const MISSING_LOC = 'c0000000-0000-0000-0000-0000000000cc'

const MASTER = { id: 'u-master', profileRole: 'master' }
const OWNER = { id: 'u-owner', profileRole: 'owner' }

function fixture() {
  return {
    locations: [{ id: LOC_ID, name: 'Stillorgan', organization_id: ORG_ID }],
  }
}

const rosterReq = () => new Request('http://localhost/api/admin/tenants')
const detailProps = (orgId) => ({ params: Promise.resolve({ orgId }) })
const adjustReq = (body) =>
  new Request('http://localhost/api/admin/tenants/wallet-adjust', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

let rpc

beforeEach(() => {
  rpc = vi.fn(async () => ({ data: 4750, error: null }))
  db = { ...makeFakeDb(fixture()), rpc }
  currentUser = MASTER
  vi.mocked(getTenantsRoster).mockReset().mockResolvedValue({ stats: {}, orgs: [] })
  vi.mocked(getTenantDetail).mockReset().mockResolvedValue({ org: { id: ORG_ID }, locations: [] })
  vi.mocked(logAuditEvent).mockClear()
})

describe('auth matrix (401 / 403)', () => {
  it.each([
    ['GET roster', () => GET(rosterReq())],
    ['GET detail', () => GET_DETAIL(new Request('http://localhost/x'), detailProps(ORG_ID))],
    ['POST wallet-adjust', () => POST_ADJUST(adjustReq({ locationId: LOC_ID, amountCents: 500, note: 'goodwill' }))],
  ])('%s → 401 with no session, 403 for a non-master', async (_name, call) => {
    currentUser = null
    expect((await call()).status).toBe(401)
    currentUser = OWNER
    expect((await call()).status).toBe(403)
  })
})

describe('GET /api/admin/tenants — roster', () => {
  it('returns the assembled roster for a master', async () => {
    vi.mocked(getTenantsRoster).mockResolvedValue({ stats: { mrrCents: 0 }, orgs: [{ id: ORG_ID }] })
    const res = await GET(rosterReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.orgs).toHaveLength(1)
  })

  it('500s with the assembler message on failure', async () => {
    vi.mocked(getTenantsRoster).mockRejectedValue(new Error('boom'))
    const res = await GET(rosterReq())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('boom')
  })
})

describe('GET /api/admin/tenants/[orgId] — drill-in', () => {
  it('404s a malformed id without touching the db (no enumeration, no cast error)', async () => {
    const res = await GET_DETAIL(new Request('http://localhost/x'), detailProps('not-a-uuid'))
    expect(res.status).toBe(404)
    expect(getTenantDetail).not.toHaveBeenCalled()
  })

  it('404s an unknown org (detail semantics: 404 not 403)', async () => {
    vi.mocked(getTenantDetail).mockResolvedValue(null)
    const res = await GET_DETAIL(new Request('http://localhost/x'), detailProps(ORG_ID))
    expect(res.status).toBe(404)
  })

  it('returns the drill-in payload', async () => {
    const res = await GET_DETAIL(new Request('http://localhost/x'), detailProps(ORG_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.org.id).toBe(ORG_ID)
  })
})

describe('POST /api/admin/tenants/wallet-adjust — validation', () => {
  it.each([
    ['zero amount', { locationId: LOC_ID, amountCents: 0, note: 'valid note' }],
    ['non-integer amount', { locationId: LOC_ID, amountCents: 12.5, note: 'valid note' }],
    ['over +€10,000', { locationId: LOC_ID, amountCents: 1_000_001, note: 'valid note' }],
    ['under -€10,000', { locationId: LOC_ID, amountCents: -1_000_001, note: 'valid note' }],
    ['short note', { locationId: LOC_ID, amountCents: 500, note: 'hey' }],
    ['whitespace-padded short note', { locationId: LOC_ID, amountCents: 500, note: '  hi   ' }],
    ['missing note', { locationId: LOC_ID, amountCents: 500 }],
    ['malformed location id', { locationId: 'nope', amountCents: 500, note: 'valid note' }],
  ])('400s on %s and never reaches the RPC', async (_name, body) => {
    const res = await POST_ADJUST(adjustReq(body))
    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('boundary amounts of exactly ±1,000,000 cents are accepted', async () => {
    for (const amountCents of [1_000_000, -1_000_000]) {
      const res = await POST_ADJUST(adjustReq({ locationId: LOC_ID, amountCents, note: 'boundary check' }))
      expect(res.status).toBe(200)
    }
  })

  it('404s an unknown location before the RPC', async () => {
    const res = await POST_ADJUST(adjustReq({ locationId: MISSING_LOC, amountCents: 500, note: 'valid note' }))
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('POST /api/admin/tenants/wallet-adjust — the write', () => {
  it('posts kind=adjustment through wallet_apply with the acting master as created_by', async () => {
    const res = await POST_ADJUST(adjustReq({ locationId: LOC_ID, amountCents: -2500, note: 'Correction — double top-up' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toEqual({ locationId: LOC_ID, balanceCents: 4750 })

    expect(rpc).toHaveBeenCalledTimes(1)
    const [fn, args] = rpc.mock.calls[0]
    expect(fn).toBe('wallet_apply')
    expect(args).toMatchObject({
      p_location_id: LOC_ID,
      p_kind: 'adjustment',
      p_amount_cents: -2500,
      p_note: 'Correction — double top-up',
      p_created_by: MASTER.id,
    })
  })

  it('audit-logs the adjustment (secondary trail; ledger row is primary)', async () => {
    await POST_ADJUST(adjustReq({ locationId: LOC_ID, amountCents: 1000, note: 'Goodwill credit' }))
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logAuditEvent).mock.calls[0][0]).toMatchObject({
      category: 'admin',
      action: 'wallet_adjustment',
      locationId: LOC_ID,
    })
  })

  it('surfaces an RPC refusal (e.g. grace-floor breach) as a 400', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'wallet_apply: balance would breach the grace floor' } })
    const res = await POST_ADJUST(adjustReq({ locationId: LOC_ID, amountCents: -900000, note: 'big debit' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/grace floor/)
  })
})
