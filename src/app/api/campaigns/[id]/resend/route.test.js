// CAMPAIGN-RESEND — cancel a pending resend-to-non-openers.
//
// DELETE clears campaigns.resend_enabled on the parent. Cheap because
// the child doesn't exist until the spawner fires; once it HAS fired
// (a child row exists) cancellation is a 409 — the resend is a live
// campaign now and is cancelled through the normal campaign cancel.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let campaignRow = null
let childRow = null
let updates = []
// GATES-3 (d) — injectable failures for the three reads/writes.
let campaignErr = null
let childErr = null
let updateErr = null

const fakeDb = {
  from: () => {
    const state = { op: 'select', filters: {} }
    const b = {}
    b.select = () => b
    b.eq = (col, val) => { state.filters[col] = val; return b }
    b.update = (patch) => { state.op = 'update'; state.patch = patch; return b }
    b.single = () => Promise.resolve(
      campaignErr ? { data: null, error: campaignErr }
        : campaignRow ? { data: campaignRow, error: null } : { data: null, error: { code: 'PGRST116', message: 'not found' } })
    b.maybeSingle = () => Promise.resolve(childErr ? { data: null, error: childErr } : { data: childRow, error: null })
    b.then = (resolve, reject) => {
      if (state.op === 'update') updates.push({ patch: state.patch, filters: state.filters })
      return Promise.resolve({ data: null, error: state.op === 'update' ? updateErr : null }).then(resolve, reject)
    }
    return b
  },
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
// GATES-2 — the route now asks `email` at the campaign's studio (covered in
// tests/role-sweep/gates2-routes.test.js); these tests are about the flag, so
// the caller holds it.
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: vi.fn(() => true),
  hasPermissionForLocation: vi.fn(() => true),
}))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'user-1' })),
  assertLocationAccessOr404: vi.fn(() => null),
}))

import { DELETE } from './route.js'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'

const props = { params: Promise.resolve({ id: 'camp-1' }) }
const call = () => DELETE(new Request('http://test.local', { method: 'DELETE' }), props)

beforeEach(() => {
  vi.clearAllMocks()
  campaignRow = { id: 'camp-1', location_id: 'loc-1', resend_enabled: true }
  childRow = null
  updates = []
  campaignErr = null
  childErr = null
  updateErr = null
})

describe('DELETE /api/campaigns/[id]/resend', () => {
  it('requires a session', async () => {
    getCurrentUser.mockResolvedValueOnce(null)
    const res = await call()
    expect(res.status).toBe(401)
    expect(updates).toHaveLength(0)
  })

  it('404s a campaign at a foreign location (guard result wins)', async () => {
    const guard = new Response(null, { status: 404 })
    assertLocationAccessOr404.mockReturnValueOnce(guard)
    const res = await call()
    expect(res.status).toBe(404)
    expect(updates).toHaveLength(0)
  })

  it('clears the flag on a pending resend', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(updates).toHaveLength(1)
    expect(updates[0].patch).toEqual({ resend_enabled: false })
    expect(updates[0].filters.id).toBe('camp-1')
  })

  it('409s once the resend child already exists', async () => {
    childRow = { id: 'child-1' }
    const res = await call()
    expect(res.status).toBe(409)
    expect(updates).toHaveLength(0)
  })

  it('200s idempotently when no resend was pending', async () => {
    campaignRow = { ...campaignRow, resend_enabled: false }
    const res = await call()
    expect(res.status).toBe(200)
  })

  // GATES-3 (d) — every error is read (the discarded-error class).
  it('a failed flag write is a 500, never a success', async () => {
    updateErr = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = await call()
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })

  it('a failed child read is a 500 and the flag is left alone (never read as "no child")', async () => {
    childErr = { code: '57014', message: 'timeout' }
    const res = await call()
    expect(res.status).toBe(500)
    expect(updates).toHaveLength(0)
  })

  it('a failed campaign read is a 500, a missing one a 404', async () => {
    campaignErr = { code: '57014', message: 'timeout' }
    expect((await call()).status).toBe(500)
    campaignErr = null
    campaignRow = null
    expect((await call()).status).toBe(404)
    expect(updates).toHaveLength(0)
  })
})
