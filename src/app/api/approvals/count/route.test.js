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

  // The registry is mocked to return 0 here, so the 0 itself proves nothing —
  // what this test actually proves is that a `staff` role is NOT 403'd, i.e.
  // that permission: null is in effect and the real gate lives entirely
  // inside getPendingApprovalsCount, not in this route.
  it('does not 403 a staff session — permission: null, so an ineligible caller gets a quiet 0', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u2', role: 'staff', activeLocation: { id: 'loc1' } })
    getPendingApprovalsCount.mockResolvedValue(0)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { count: 0 } })
  })

  // location: false — avoids a 400 for a session with no active location.
  // Such a session's count is host_events-only (the one org-scoped
  // provider); every other provider needs the caller's active location to
  // have anything to count.
  it('does not require an active location', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u3', role: 'owner', activeLocation: null })
    getPendingApprovalsCount.mockResolvedValue(4)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { count: 4 } })
  })

  // Fix 4 (TDD step 1) — the synchronous APPROVALS_PROVIDERS.filter(...)
  // gate in getPendingApprovalsCount runs OUTSIDE the Promise.allSettled
  // that swallows per-provider failures. If getPendingApprovalsCount
  // rejects for any reason, the route must not throw an opaque 500 with
  // no repo envelope — it must answer { success: false, error } like its
  // sibling src/app/api/home-queue/count/route.js does.
  it('answers a repo-envelope 500 when getPendingApprovalsCount rejects', async () => {
    getCurrentUser.mockResolvedValue(headCoach)
    getPendingApprovalsCount.mockRejectedValue(new Error('boom'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })
})
