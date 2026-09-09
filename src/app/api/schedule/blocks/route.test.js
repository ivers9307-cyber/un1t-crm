// ROSTER-FIX.2 — role gate on GET /api/schedule/blocks.
//
// The blocks feed carries every coach on every block (names + emails) plus
// capacity, i.e. the manager's ManageMode view. mobile/lib/schedule-api.js
// already documents it as "MANAGER_ROLES-gated"; it wasn't.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => ['loc-1']),
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET } = await import('./route.js')

function req(url = 'http://x/api/schedule/blocks?location_id=loc-1') {
  return { url, headers: { get: () => '' } }
}

function buildDb(rows) {
  const q = {}
  for (const op of ['eq', 'in', 'gte', 'lte', 'order']) q[op] = () => q
  q.then = (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej)
  return { from: () => ({ select: () => q }) }
}

beforeEach(() => { createServerClient.mockReset(); getCurrentUser.mockReset() })

describe('GET /api/schedule/blocks — role gate', () => {
  it('403 for a coach', async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff' })
    createServerClient.mockReturnValue(buildDb([]))
    const res = await GET(req())
    expect(res.status).toBe(403)
  })

  it('200 for a manager', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager' })
    createServerClient.mockReturnValue(buildDb([{ id: 'b1' }]))
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([{ id: 'b1' }])
  })
})
