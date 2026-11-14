// APPROVALSQ.4 — who may decide a host event. The route must agree with the
// approvals provider's visibility rule (src/lib/approvals/providers/host-events.js):
// master, owner or manager by the global role OR by the role held at the
// viewer's active studio. Nothing wider, nothing narrower.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ user: null, updates: [] }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => mocks.user) }))
vi.mock('@/lib/hosts', () => ({
  loadHostForOrg: vi.fn(async (_db, id, orgId) => (orgId === 'org-1' ? { id, name: 'Host', organization_id: orgId } : null)),
}))
vi.mock('@/lib/host-notifications', () => ({ notifyHostEventReviewed: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const chain = {
        select: () => chain, eq: () => chain,
        maybeSingle: async () => ({ data: { id: 'ev-1', host_id: 'h1', status: 'pending_review', name: 'Ev', slug: 'ev', location_id: 'loc-a' }, error: null }),
        update: (patch) => { mocks.updates.push(patch); return chain },
        then: (resolve) => resolve({ data: [{ id: 'ev-1' }], error: null }),
      }
      return chain
    },
  }),
}))

import { POST } from './route'

const req = (body) => new Request('http://x/api/events/ev-1/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const ctx = { params: Promise.resolve({ id: 'ev-1' }) }
const base = { id: 'u1', activeOrganization: { id: 'org-1' }, activeLocation: { id: 'loc-a', organization_id: 'org-1' } }
const as = (over) => { mocks.user = { ...base, ...over } }

beforeEach(() => { mocks.user = null; mocks.updates.length = 0 })

describe('POST /api/events/[id]/review: who may decide', () => {
  it('401 without a user', async () => {
    expect((await POST(req({ action: 'approve' }), ctx)).status).toBe(401)
  })

  it.each([['master'], ['owner'], ['manager']])('allows a global %s', async (role) => {
    as({ role, rolesByLocation: {} })
    const res = await POST(req({ action: 'approve' }), ctx)
    expect(res.status).toBe(200)
    expect(mocks.updates).toHaveLength(1)
  })

  it('allows someone who is manager at the active studio by per-location role', async () => {
    as({ role: 'staff', rolesByLocation: { 'loc-a': 'manager' } })
    expect((await POST(req({ action: 'approve' }), ctx)).status).toBe(200)
  })

  it('allows an owner at the active studio by per-location role', async () => {
    as({ role: 'staff', rolesByLocation: { 'loc-a': 'owner' } })
    expect((await POST(req({ action: 'reject', reason: 'No' }), ctx)).status).toBe(200)
  })

  it('still refuses a manager at a different studio (not the active one)', async () => {
    as({ role: 'staff', rolesByLocation: { 'loc-a': 'staff', 'loc-b': 'manager' } })
    const res = await POST(req({ action: 'approve' }), ctx)
    expect(res.status).toBe(403)
    expect(mocks.updates).toHaveLength(0)
  })

  it('still refuses plain staff and head coaches', async () => {
    for (const role of ['staff', 'head_coach']) {
      as({ role, rolesByLocation: { 'loc-a': role } })
      expect((await POST(req({ action: 'approve' }), ctx)).status).toBe(403)
    }
    expect(mocks.updates).toHaveLength(0)
  })

  it('still scopes to the caller organisation', async () => {
    as({ role: 'manager', activeOrganization: { id: 'org-2' }, activeLocation: { id: 'loc-a', organization_id: 'org-2' } })
    expect((await POST(req({ action: 'approve' }), ctx)).status).toBe(404)
  })
})
