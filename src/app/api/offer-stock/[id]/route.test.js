import { describe, it, expect, vi, beforeEach } from 'vitest'

const ID = '11111111-1111-4111-8111-111111111111'
const state = {}

vi.mock('@/lib/auth', () => ({
  getCurrentUser: async () => state.user,
  assertLocationAccessOr404: (user, locationId) => (
    user?.rolesByLocation?.[locationId] || user?.profileRole === 'master'
      ? null
      : new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
  ),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => {
    const c = {
      from: () => c,
      select: () => c,
      eq: (k, v) => { state.filters[k] = v; return c },
      maybeSingle: async () => ({ data: state.offer, error: state.readError }),
      update: (patch) => { state.patch = patch; return c },
      then: (resolve) => resolve({ data: state.saved, error: state.writeError }),
    }
    return c
  },
}))

import { PATCH } from './route'

const send = (body, id = ID) => PATCH(new Request('http://test/x', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) })

beforeEach(() => {
  Object.assign(state, {
    user: { rolesByLocation: { L1: 'manager' } },
    offer: { id: ID, location_id: 'L1' },
    saved: [{ id: ID }],
    readError: null, writeError: null, patch: null, filters: {},
  })
})

describe('PATCH /api/offer-stock/[id]', () => {
  it('saves a limit inside the offer\'s studio', async () => {
    const res = await send({ stock_limit: 4 })
    expect(res.status).toBe(200)
    expect(state.patch.stock_limit).toBe(4)
    expect(state.filters.location_id).toBe('L1')
  })
  it('clears a limit with null', async () => {
    expect((await send({ stock_limit: null })).status).toBe(200)
    expect(state.patch.stock_limit).toBeNull()
  })
  it.each([[0], [-1], [1.5], ['4']])('refuses %s', async (stock_limit) => {
    expect((await send({ stock_limit })).status).toBe(400)
    expect(state.patch).toBeNull()
  })
  it('needs a session', async () => {
    state.user = null
    expect((await send({ stock_limit: 4 })).status).toBe(401)
  })
  it('hides another studio\'s offer', async () => {
    state.user = { rolesByLocation: { L2: 'owner' } }
    expect((await send({ stock_limit: 4 })).status).toBe(404)
    expect(state.patch).toBeNull()
  })
  it.each(['head_coach', 'staff'])('refuses a %s', async (role) => {
    state.user = { rolesByLocation: { L1: role } }
    expect((await send({ stock_limit: 4 })).status).toBe(403)
    expect(state.patch).toBeNull()
  })
  it('404s a malformed id', async () => {
    expect((await send({ stock_limit: 4 }, 'nope')).status).toBe(404)
  })
  it('reports a write that changed nothing', async () => {
    state.saved = []
    expect((await send({ stock_limit: 4 })).status).toBe(500)
  })
})
