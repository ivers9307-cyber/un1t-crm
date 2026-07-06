// XERO-API.2 PR 2 — picker endpoint coverage.
//
// We're locking three things:
//   1. The 403 when a non-master user is missing the location from
//      their assignments (the IDOR guard).
//   2. The default filter — type=EXPENSE + status=ACTIVE applied.
//      Tested by spying on the supabase chain.
//   3. The `stale` flag computation — true when no last-synced
//      timestamp OR > 30 days.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
}))

const mockDb = { from: vi.fn() }
vi.mock('@/lib/supabase', () => ({ createServerClient: () => mockDb }))

let GET
beforeEach(async () => {
  vi.resetModules()
  mockDb.from.mockReset()
  ;({ GET } = await import('./route'))
})

// Helper — builds a chainable supabase mock that resolves to the
// supplied terminal value on `.limit()` (for the accounts query)
// or `.maybeSingle()` (for the connection lookup).
function makeChain(terminal) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn(() => Promise.resolve(terminal)),
    maybeSingle: vi.fn(() => Promise.resolve(terminal)),
  }
}

async function getMock() {
  return await import('@/lib/auth').then((m) => m.getCurrentUser)
}

const fakeReq = (url) => new Request(url || 'http://localhost/api/locations/loc1/xero/accounts')
const fakeProps = { params: Promise.resolve({ id: 'loc1' }) }

describe('GET /api/locations/[id]/xero/accounts', () => {
  it('returns 401 when no user', async () => {
    const getCurrentUser = await getMock()
    getCurrentUser.mockResolvedValueOnce(null)
    const res = await GET(fakeReq(), fakeProps)
    expect(res.status).toBe(401)
  })

  it('returns 403 when non-master user lacks the location', async () => {
    const getCurrentUser = await getMock()
    getCurrentUser.mockResolvedValueOnce({
      id: 'u1', role: 'owner', locations: [{ id: 'OTHER' }],
    })
    const res = await GET(fakeReq(), fakeProps)
    expect(res.status).toBe(403)
  })

  it('defaults to the bill-codeable account set (SPEND) + ACTIVE, and reports fresh cache', async () => {
    const getCurrentUser = await getMock()
    getCurrentUser.mockResolvedValueOnce({
      id: 'u1', role: 'owner', locations: [{ id: 'loc1' }],
    })

    const accountsChain = makeChain({
      data: [{ id: 'a1', xero_account_id: 'X1', code: '7460', name: 'Subsistence', account_type: 'OVERHEADS', tax_type: 'INPUT2' }],
      error: null,
    })
    const connChain = makeChain({
      data: { accounts_last_synced_at: new Date().toISOString() },
      error: null,
    })
    mockDb.from.mockImplementation((t) => {
      if (t === 'xero_accounts') return accountsChain
      if (t === 'xero_connections') return connChain
      throw new Error(`unexpected table ${t}`)
    })

    const res = await GET(fakeReq(), fakeProps)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.accounts).toHaveLength(1)
    expect(j.stale).toBe(false)
    // status/location via .eq; the account_type filter is now a
    // multi-type .in() (EXPENSE was too narrow — hid OVERHEADS/DIRECTCOSTS).
    const eqCalls = accountsChain.eq.mock.calls.map((c) => c[0] + '=' + c[1])
    expect(eqCalls).toContain('location_id=loc1')
    expect(eqCalls).toContain('status=ACTIVE')
    expect(eqCalls).not.toContain('account_type=EXPENSE')
    const inCall = accountsChain.in.mock.calls.find((c) => c[0] === 'account_type')
    expect(inCall).toBeTruthy()
    expect(inCall[1]).toEqual(expect.arrayContaining(['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS']))
  })

  it('filters to a single AccountType when an explicit type is passed', async () => {
    const getCurrentUser = await getMock()
    getCurrentUser.mockResolvedValueOnce({ id: 'u1', role: 'master', locations: [] })
    const accountsChain = makeChain({ data: [], error: null })
    const connChain = makeChain({ data: { accounts_last_synced_at: new Date().toISOString() }, error: null })
    mockDb.from.mockImplementation((t) => t === 'xero_accounts' ? accountsChain : connChain)

    await GET(fakeReq('http://localhost/api/locations/loc1/xero/accounts?type=OVERHEADS'), fakeProps)
    const eqCalls = accountsChain.eq.mock.calls.map((c) => c[0] + '=' + c[1])
    expect(eqCalls).toContain('account_type=OVERHEADS')
  })

  it('reports stale=true when last_synced_at is null', async () => {
    const getCurrentUser = await getMock()
    getCurrentUser.mockResolvedValueOnce({ id: 'u1', role: 'master', locations: [] })

    const accountsChain = makeChain({ data: [], error: null })
    const connChain = makeChain({ data: { accounts_last_synced_at: null }, error: null })
    mockDb.from.mockImplementation((t) => t === 'xero_accounts' ? accountsChain : connChain)

    const res = await GET(fakeReq(), fakeProps)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.stale).toBe(true)
  })

  it('reports stale=true when last_synced_at is > 30 days old', async () => {
    const getCurrentUser = await getMock()
    getCurrentUser.mockResolvedValueOnce({ id: 'u1', role: 'master', locations: [] })

    const oldDate = new Date(Date.now() - 45 * 86400_000).toISOString()
    const accountsChain = makeChain({ data: [], error: null })
    const connChain = makeChain({ data: { accounts_last_synced_at: oldDate }, error: null })
    mockDb.from.mockImplementation((t) => t === 'xero_accounts' ? accountsChain : connChain)

    const res = await GET(fakeReq(), fakeProps)
    const j = await res.json()
    expect(j.stale).toBe(true)
  })

  it('bypasses account_type filter when type=ALL', async () => {
    const getCurrentUser = await getMock()
    getCurrentUser.mockResolvedValueOnce({ id: 'u1', role: 'master', locations: [] })

    const accountsChain = makeChain({ data: [], error: null })
    const connChain = makeChain({ data: { accounts_last_synced_at: new Date().toISOString() }, error: null })
    mockDb.from.mockImplementation((t) => t === 'xero_accounts' ? accountsChain : connChain)

    await GET(fakeReq('http://localhost/api/locations/loc1/xero/accounts?type=ALL'), fakeProps)
    const eqCalls = accountsChain.eq.mock.calls.map((c) => c[0])
    expect(eqCalls).not.toContain('account_type')
  })
})
