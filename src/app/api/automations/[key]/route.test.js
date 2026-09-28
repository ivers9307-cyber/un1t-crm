import { describe, it, expect, vi, beforeEach } from 'vitest'

// ROLESWEEP.1a — the route judges MANAGER_ROLES at the location with the real
// per-location helpers, so the fixtures carry rolesByLocation.
vi.mock('@/lib/auth', async () => {
  const { hasRoleAtLocation, hasRoleAtAnyLocation } = await import('@/lib/role-at-location')
  return { getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null), hasRoleAtLocation, hasRoleAtAnyLocation }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PUT } from './route.js'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

function req(body) {
  return { json: async () => body }
}

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
})

describe('PUT /api/automations/[key]', () => {
  it('403 when not a manager+', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff', id: 'u1', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'staff' } })
    const res = await PUT(req({ location_id: 'a0000000-0000-0000-0000-000000000001', enabled: true }), { params: Promise.resolve({ key: 'glofox_lead_provisioning' }) })
    expect(res.status).toBe(403)
  })

  it('400 on an unknown automation key', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'owner' } })
    const res = await PUT(req({ location_id: 'a0000000-0000-0000-0000-000000000001', enabled: true }), { params: Promise.resolve({ key: 'nope' }) })
    expect(res.status).toBe(400)
  })

  it('upserts the toggle and returns success', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'owner' } })
    const upsert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { location_id: 'a0000000-0000-0000-0000-000000000001', automation_key: 'glofox_lead_provisioning', enabled: true }, error: null }) }) }))
    createServerClient.mockReturnValue({ from: () => ({ upsert }) })
    const res = await PUT(req({ location_id: 'a0000000-0000-0000-0000-000000000001', enabled: true }), { params: Promise.resolve({ key: 'glofox_lead_provisioning' }) })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(upsert).toHaveBeenCalled()
    expect(upsert.mock.calls[0][0]).toMatchObject({ location_id: 'a0000000-0000-0000-0000-000000000001', automation_key: 'glofox_lead_provisioning', enabled: true })
  })

  it('honours the location guard (403 from assertLocationAccess)', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1', rolesByLocation: { 'a0000000-0000-0000-0000-000000000001': 'owner' } })
    const { NextResponse } = await import('next/server')
    assertLocationAccess.mockReturnValue(NextResponse.json({ success: false }, { status: 403 }))
    const res = await PUT(req({ location_id: 'b0000000-0000-0000-0000-000000000002', enabled: true }), { params: Promise.resolve({ key: 'glofox_lead_provisioning' }) })
    expect(res.status).toBe(403)
  })
})
