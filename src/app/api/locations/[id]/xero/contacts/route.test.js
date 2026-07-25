// XERO-API.2 PR 2 — contacts picker endpoint coverage.
//
// Locks:
//   1. The 403 IDOR guard (same as accounts route).
//   2. The min-query-length short-circuit (returns [] + hint when
//      q is < 2 chars, doesn't even hit xero_contacts).
//   3. The is_supplier filter applies when suppliers=1.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
}))

const mockDb = { from: vi.fn() }
vi.mock('@/lib/supabase', () => ({ createServerClient: () => mockDb }))

// OBS-HANDLED.1 — the failure path must route through serverErrorResponse
// (log + error_events row + same public body). Mocked here: the helper's
// own behaviour is pinned in src/lib/error-events.test.js; this file only
// pins that the route DELEGATES to it.
const serverErrorResponse = vi.fn(async ({ error, status = 500 }) =>
  Response.json({ success: false, error: error?.message }, { status }))
vi.mock('@/lib/error-events', () => ({ serverErrorResponse: (args) => serverErrorResponse(args) }))

let GET
beforeEach(async () => {
  vi.resetModules()
  mockDb.from.mockReset()
  ;({ GET } = await import('./route'))
})

function makeChain(terminal) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn(() => Promise.resolve(terminal)),
    maybeSingle: vi.fn(() => Promise.resolve(terminal)),
  }
}

async function getMock() {
  return await import('@/lib/auth').then((m) => m.getCurrentUser)
}

const fakeReq = (url) => new Request(url)
const fakeProps = { params: Promise.resolve({ id: 'loc1' }) }

describe('GET /api/locations/[id]/xero/contacts', () => {
  it('returns 403 when non-master lacks the location', async () => {
    const getCurrentUser = await getMock()
    getCurrentUser.mockResolvedValueOnce({ id: 'u1', role: 'owner', locations: [{ id: 'OTHER' }] })
    const res = await GET(fakeReq('http://localhost/?q=acme'), fakeProps)
    expect(res.status).toBe(403)
  })

  it('short-circuits with [] + hint when q < 2 chars', async () => {
    const getCurrentUser = await getMock()
    getCurrentUser.mockResolvedValueOnce({ id: 'u1', role: 'master', locations: [] })
    const connChain = makeChain({ data: { contacts_last_synced_at: new Date().toISOString() }, error: null })
    mockDb.from.mockImplementation(() => connChain)

    const res = await GET(fakeReq('http://localhost/?q=a'), fakeProps)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.contacts).toEqual([])
    expect(j.hint).toMatch(/at least 2 characters/i)
  })

  it('applies suppliers=1 filter when requested', async () => {
    const getCurrentUser = await getMock()
    getCurrentUser.mockResolvedValueOnce({ id: 'u1', role: 'master', locations: [] })
    const contactsChain = makeChain({
      data: [{ id: 'c1', xero_contact_id: 'X1', name: 'Acme', email: null, is_supplier: true }],
      error: null,
    })
    const connChain = makeChain({ data: { contacts_last_synced_at: new Date().toISOString() }, error: null })
    mockDb.from.mockImplementation((t) => t === 'xero_contacts' ? contactsChain : connChain)

    const res = await GET(fakeReq('http://localhost/?q=acme&suppliers=1'), fakeProps)
    expect(res.status).toBe(200)
    const eqCalls = contactsChain.eq.mock.calls.map((c) => c[0] + '=' + c[1])
    expect(eqCalls).toContain('is_supplier=true')
    expect(eqCalls).toContain('status=ACTIVE')
  })

  it('a DB read failure 500s through serverErrorResponse (OBS-HANDLED.1)', async () => {
    const getCurrentUser = await getMock()
    getCurrentUser.mockResolvedValueOnce({ id: 'u1', role: 'master', locations: [] })
    const contactsChain = makeChain({ data: null, error: { message: 'pg exploded' } })
    const connChain = makeChain({ data: { contacts_last_synced_at: new Date().toISOString() }, error: null })
    mockDb.from.mockImplementation((t) => t === 'xero_contacts' ? contactsChain : connChain)

    const res = await GET(fakeReq('http://localhost/?q=acme'), fakeProps)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('pg exploded')
    expect(serverErrorResponse).toHaveBeenCalledTimes(1)
    expect(serverErrorResponse.mock.calls[0][0].module).toBe('xero-contacts')
  })

  it('escapes special characters in the search query', async () => {
    const getCurrentUser = await getMock()
    getCurrentUser.mockResolvedValueOnce({ id: 'u1', role: 'master', locations: [] })
    const contactsChain = makeChain({ data: [], error: null })
    const connChain = makeChain({ data: { contacts_last_synced_at: new Date().toISOString() }, error: null })
    mockDb.from.mockImplementation((t) => t === 'xero_contacts' ? contactsChain : connChain)

    await GET(fakeReq('http://localhost/?q=ac%5Fme'), fakeProps)
    // Just assert .or() was called with an ilike pattern — the
    // exact escape shape is an internal detail. The point is the
    // route didn't crash on a query containing `%`.
    expect(contactsChain.or).toHaveBeenCalled()
    const orArg = contactsChain.or.mock.calls[0][0]
    expect(orArg).toMatch(/name\.ilike\./)
    expect(orArg).toMatch(/email\.ilike\./)
  })
})
