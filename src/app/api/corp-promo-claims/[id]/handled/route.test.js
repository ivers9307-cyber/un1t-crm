import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ user: null, row: null, readError: null, updated: [], perm: true }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: async () => m.user,
  assertLocationAccessOr404: (user, loc) => (user.locations.includes(loc) ? null : new Response(JSON.stringify({ success: false }), { status: 404 })),
}))
vi.mock('@/lib/permissions', () => ({ hasPermissionAtAnyLocation: () => m.perm, hasPermissionForLocation: () => m.perm }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      let patch = null
      const q = {
        select: () => q, eq: () => q,
        update: (p) => { patch = p; return q },
        maybeSingle: async () => ({ data: m.row, error: m.readError }),
        then: (ok, no) => { m.updated.push(patch); return Promise.resolve({ data: [{ id: 'c1' }], error: null }).then(ok, no) },
      }
      return q
    },
  }),
}))

import { POST } from './route'
const call = async () => { const r = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id: 'c1' }) }); return { status: r.status, json: await r.json() } }

beforeEach(() => {
  m.user = { id: 'u1', locations: ['loc-h'] }
  m.row = { id: 'c1', location_id: 'loc-h', status: 'help_requested' }
  m.readError = null
  m.updated = []
  m.perm = true
})

describe('POST /api/corp-promo-claims/[id]/handled', () => {
  it('closes an open claim, recording who', async () => {
    expect((await call()).status).toBe(200)
    expect(m.updated[0]).toMatchObject({ status: 'handled', handled_by: 'u1' })
  })
  it('another studio: 404; no session: 401; no permission: 403', async () => {
    m.row.location_id = 'loc-other'
    expect((await call()).status).toBe(404)
    m.user = null
    expect((await call()).status).toBe(401)
    m.user = { id: 'u1', locations: ['loc-h'] }; m.perm = false
    expect((await call()).status).toBe(403)
  })
  it('already handled is a no-op success; a granted claim is 409', async () => {
    m.row.status = 'handled'
    expect((await call()).json.data.already).toBe(true)
    m.row.status = 'granted'
    expect((await call()).status).toBe(409)
    expect(m.updated).toEqual([])
  })
})
