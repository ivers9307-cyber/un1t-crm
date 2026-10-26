// PINSCOPE.1 — POST /api/auth/set-pin: uniqueness is checked within the
// caller's organisations (never the estate), and POST is rate-limited per
// user so the 409 cannot be used to enumerate which PINs exist.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', async (orig) => {
  const actual = await orig()
  return { ...actual, checkRateLimit: vi.fn() }
})
vi.mock('@/lib/studio-pin', async (orig) => {
  const actual = await orig()
  return { ...actual, pinHoldersInOrgs: vi.fn() }
})

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { checkRateLimit } = await import('@/lib/rate-limit')
const { pinHoldersInOrgs, hashPin } = await import('@/lib/studio-pin')
const { POST } = await import('./route.js')

const USER = {
  id: 'me',
  locations: [
    { id: 'loc-a1', organization_id: 'org-a' },
    { id: 'loc-a2', organization_id: 'org-a' },
  ],
  orgAdminOrgIds: ['org-c'],
}

const req = (pin) => new Request('http://test/api/auth/set-pin', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pin }),
})

let updates
function mockDb() {
  updates = []
  return {
    from: vi.fn(() => ({
      update: vi.fn((u) => {
        updates.push(u)
        return { eq: vi.fn(() => Promise.resolve({ error: null })) }
      }),
    })),
  }
}

const allowed = { allowed: true, remaining: 9, resetAt: new Date(), retryAfterSec: 60 }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(USER)
  createServerClient.mockReturnValue(mockDb())
  checkRateLimit.mockResolvedValue(allowed)
  pinHoldersInOrgs.mockResolvedValue([])
})

describe('POST /api/auth/set-pin', () => {
  it('401 when signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req('1234'))).status).toBe(401)
  })

  it('429 once the per-user limit is spent, before any PIN is compared', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(), retryAfterSec: 120 })
    const res = await POST(req('1234'))
    expect(res.status).toBe(429)
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), 'set-pin:me', expect.objectContaining({ max: 10 }))
    expect(pinHoldersInOrgs).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it("checks uniqueness against the caller's organisations only", async () => {
    await POST(req('1234'))
    const [{ orgIds }] = pinHoldersInOrgs.mock.calls[0]
    expect([...new Set(orgIds)].sort()).toEqual(['org-a', 'org-c'])
  })

  it('409 when someone else in the pool holds the PIN', async () => {
    pinHoldersInOrgs.mockResolvedValue([{ id: 'colleague', full_name: 'C', pin_hash: await hashPin('1234') }])
    const res = await POST(req('1234'))
    expect(res.status).toBe(409)
    expect(updates).toEqual([])
  })

  it("does not count the caller's own current PIN as a clash", async () => {
    pinHoldersInOrgs.mockResolvedValue([{ id: 'me', full_name: 'Me', pin_hash: await hashPin('1234') }])
    const res = await POST(req('1234'))
    expect(res.status).toBe(200)
    expect(updates[0].pin_hash).toMatch(/^scrypt\$/)
  })
})
