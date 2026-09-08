// NAV-BADGE.1 — GET /api/approvals/count. Restores the badge endpoint HOME.3
// deleted. Delegates to getPendingApprovalsCount (src/lib/approvals/registry.js),
// which applies each provider's own role/location gate — this route must hold
// NO scoping logic of its own, or the badge can drift from what /approvals shows.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/approvals/registry', () => ({ getPendingApprovalsCount: vi.fn() }))

import { GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getPendingApprovalsCount } from '@/lib/approvals/registry'

const req = () => new Request('http://x/api/approvals/count')
const headCoach = { id: 'u1', role: 'head_coach', activeLocation: { id: 'loc1' } }

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue({ marker: 'db' })
})

describe('GET /api/approvals/count', () => {
  it('401s when unauthenticated, without touching the registry', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(getPendingApprovalsCount).not.toHaveBeenCalled()
  })

  it('delegates to getPendingApprovalsCount with the service-role db and the user', async () => {
    getCurrentUser.mockResolvedValue(headCoach)
    getPendingApprovalsCount.mockResolvedValue(7)
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: { count: 7 } })
    expect(getPendingApprovalsCount).toHaveBeenCalledWith({ marker: 'db' }, headCoach)
  })

  // The sidebar polls this for EVERY authenticated session (see Task 3 — a
  // client-side permission gate cannot see other locations). A session with no
  // approver authority must therefore get a cheap, quiet zero, never a 403.
  it('answers a quiet 0 for a session with no approver authority', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u2', role: 'staff', activeLocation: { id: 'loc1' } })
    getPendingApprovalsCount.mockResolvedValue(0)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { count: 0 } })
  })

  // location: false — approvals span locations (host_events is org-wide, an
  // owner sees every location they own), so requiring an active location would
  // hide real work behind a 400.
  it('does not require an active location', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u3', role: 'owner', activeLocation: null })
    getPendingApprovalsCount.mockResolvedValue(4)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { count: 4 } })
  })
})
