// TRAINERSROLE.1 — GET /api/locations/[id]/glofox-memberships judges the
// caller's role AT THE PATH LOCATION, not via `user.role` (the ACTIVE studio's
// role). Same gate and same fix as glofox-trainers. @/lib/auth is REAL; only
// getCurrentUser is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  listGlofoxMemberships: vi.fn(),
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { glofoxCredentialsForLocation, listGlofoxMemberships } from '@/lib/glofox'
import { ROLE_GATE_CASES, LOC_B } from '../_role-gate-cases.js'

const MEMBERSHIPS = [{ _id: 'm-1', name: 'Trial', plans: [{ code: 'p-1' }] }]
const call = (id) => GET({}, { params: Promise.resolve({ id }) })

describe('GET glofox-memberships — role judged at the path location', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: 'branch-1', apiKey: 'key-1', apiToken: 'token-1' })
    listGlofoxMemberships.mockResolvedValue({ ok: true, memberships: MEMBERSHIPS })
  })

  it.each(ROLE_GATE_CASES)('%s', async (_label, caller, target, status, error) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await call(target)
    expect(res.status).toBe(status)
    if (status === 200) {
      expect(await res.json()).toEqual({ success: true, memberships: MEMBERSHIPS, count: 1 })
      expect(glofoxCredentialsForLocation).toHaveBeenCalledWith(expect.anything(), target)
    } else {
      expect(await res.json()).toEqual({ success: false, error })
      expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
      expect(listGlofoxMemberships).not.toHaveBeenCalled()
    }
  })

  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call(LOC_B)
    expect(res.status).toBe(401)
    expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
  })
})
