import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { user: null, row: null, updates: [], updateError: null }

vi.mock('@/lib/auth', () => ({ getCurrentUser: async () => state.user }))
vi.mock('@/lib/permissions', () => ({
  hasPermission: (user, key) => Boolean(user?.perms?.[key]),
}))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from() { return this },
    select() { return this },
    eq() { return this },
    maybeSingle: async () => ({ data: state.row }),
    update(u) { state.updates.push(u); return { eq: async () => ({ error: state.updateError }) } },
  }),
}))

import { POST } from './route'

const props = { params: Promise.resolve({ id: 'p1' }) }
const approver = { id: 'u1', locations: [{ id: 'loc1' }], perms: { approvals_offer_purchases: true } }
const paidRow = { id: 'p1', state: 'paid', location_id: 'loc1', fulfilled_at: null }

beforeEach(() => {
  state.user = approver
  state.row = paidRow
  state.updates = []
  state.updateError = null
})

describe('POST /api/offer-purchases/[id]/fulfil', () => {
  it('401 with no session', async () => {
    state.user = null
    expect((await POST(new Request('http://t'), props)).status).toBe(401)
  })
  it('403 without the per-category grant', async () => {
    state.user = { ...approver, perms: {} }
    expect((await POST(new Request('http://t'), props)).status).toBe(403)
  })
  it('404 for an unknown id AND for a row outside the caller locations (no enumeration)', async () => {
    state.row = null
    expect((await POST(new Request('http://t'), props)).status).toBe(404)
    state.row = { ...paidRow, location_id: 'other-loc' }
    expect((await POST(new Request('http://t'), props)).status).toBe(404)
  })
  it('409 when the purchase is not paid', async () => {
    state.row = { ...paidRow, state: 'created' }
    expect((await POST(new Request('http://t'), props)).status).toBe(409)
  })
  it('stamps fulfilled_at + fulfilled_by', async () => {
    const json = await (await POST(new Request('http://t'), props)).json()
    expect(json).toEqual({ success: true, data: { fulfilled: true } })
    expect(state.updates[0].fulfilled_by).toBe('u1')
    expect(state.updates[0].fulfilled_at).toBeTruthy()
  })
  it('second call is a 200 no-op that keeps the original stamp', async () => {
    state.row = { ...paidRow, fulfilled_at: '2026-08-08T10:00:00Z' }
    const json = await (await POST(new Request('http://t'), props)).json()
    expect(json).toEqual({ success: true, data: { already: true } })
    expect(state.updates).toHaveLength(0)
  })
})
