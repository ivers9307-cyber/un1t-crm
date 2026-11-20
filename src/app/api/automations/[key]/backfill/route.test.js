import { describe, it, expect, vi, beforeEach } from 'vitest'
// ROLESWEEP.1a — the route judges MANAGER_ROLES at the location with the real
// per-location helpers, so the fixtures carry rolesByLocation.
vi.mock('@/lib/auth', async () => {
  const { hasRoleAtLocation, hasRoleAtAnyLocation } = await import('@/lib/role-at-location')
  return { getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null), hasRoleAtLocation, hasRoleAtAnyLocation }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/automations/glofox-backfill', () => ({ runGlofoxBackfillBatch: vi.fn() }))

import { GET, POST } from './route.js'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { runGlofoxBackfillBatch } from '@/lib/automations/glofox-backfill'

beforeEach(() => { vi.clearAllMocks(); assertLocationAccess.mockReturnValue(null) })
const params = (key = 'glofox_lead_provisioning') => ({ params: Promise.resolve({ key }) })

describe('GET /api/automations/[key]/backfill (count)', () => {
  // ROUTEWRAP.R6 — a signed-out call is withAuth's 401 (this route said 403).
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(new Request('http://x/api/automations/glofox_lead_provisioning/backfill?location_id=a0000000-0000-0000-0000-000000000001'), params())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })
  it("refuses a studio outside the caller's before any read", async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'owner' } })
    assertLocationAccess.mockReturnValue(new Response(null, { status: 403 }))
    const rpc = vi.fn()
    createServerClient.mockReturnValue({ rpc })
    const res = await GET(new Request('http://x/api/automations/glofox_lead_provisioning/backfill?location_id=b0000000-0000-0000-0000-000000000002'), params())
    expect(res.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('a failed count answers a fixed message', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'owner' } })
    createServerClient.mockReturnValue({ rpc: vi.fn(async () => ({ data: null, error: { code: '57014', message: 'statement timeout in glofox_backfill_eligible_count' } })) })
    const res = await GET(new Request('http://x/api/automations/glofox_lead_provisioning/backfill?location_id=a0000000-0000-0000-0000-000000000001'), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error).not.toMatch(/glofox_backfill/)
  })
  it('403 for non-manager', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'staff' } })
    const res = await GET(new Request('http://x/api/automations/glofox_lead_provisioning/backfill?location_id=a0000000-0000-0000-0000-000000000001'), params())
    expect(res.status).toBe(403)
  })
  it('returns the eligible count', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1', locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }], rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'owner' } })
    createServerClient.mockReturnValue({ rpc: vi.fn(async () => ({ data: 7, error: null })) })
    const res = await GET(new Request('http://x/api/automations/glofox_lead_provisioning/backfill?location_id=a0000000-0000-0000-0000-000000000001'), params())
    const body = await res.json()
    expect(body).toMatchObject({ success: true, data: { eligible: 7 } })
  })
})

describe('POST /api/automations/[key]/backfill (run batch)', () => {
  it('401 signed out, no batch', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ location_id: 'a0000000-0000-0000-0000-000000000001' }) }), params())
    expect(res.status).toBe(401)
    expect(runGlofoxBackfillBatch).not.toHaveBeenCalled()
  })
  it('403 for non-manager', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'staff' } })
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ location_id: 'a0000000-0000-0000-0000-000000000001' }) }), params())
    expect(res.status).toBe(403)
  })
  it('400 on unknown key', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'owner' } })
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ location_id: 'a0000000-0000-0000-0000-000000000001' }) }), params('nope'))
    expect(res.status).toBe(400)
  })
  it('runs a batch and returns the summary', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'owner' } })
    createServerClient.mockReturnValue({})
    runGlofoxBackfillBatch.mockResolvedValue({ processed: 2, created: 2, linked: 0, needs_review: 0, failed: 0, skipped: 0, remaining: 5 })
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ location_id: 'a0000000-0000-0000-0000-000000000001' }) }), params())
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ processed: 2, remaining: 5 })
    expect(runGlofoxBackfillBatch).toHaveBeenCalled()
  })
})
