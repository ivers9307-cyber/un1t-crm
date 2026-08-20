// SEC-LIVE-GATE.1 — /live convenience redirect had no permission check at
// all: only login + (downstream) location membership gated the coach
// heart-rate board. The sidebar link is gated on `studio_management`
// ("Same permission gate as Studio Management" — src/lib/nav-items.js) and
// /members' hub index assumes the same gate (src/app/members/page.js), but
// nothing enforced it server-side — any logged-in staffer could hit /live
// directly. Mirrors the studio-management page's own gate
// (src/app/(operations)/studio-management/page.js).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
}))

import LiveRedirectPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

function user({ activeLocationId = 'loc1', perms = {} } = {}) {
  return {
    id: 'u1',
    role: 'staff',
    activeLocation: activeLocationId ? { id: activeLocationId } : null,
    activeAssignment: { permissions: { studio_management: false, ...perms } },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('/live redirect page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(LiveRedirectPage()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('redirects to / when the user lacks studio_management, even with an active location', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { studio_management: false } }))
    await expect(LiveRedirectPage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('redirects to /live/<activeLocation> when the user holds studio_management', async () => {
    getCurrentUser.mockResolvedValue(user({ activeLocationId: 'loc9', perms: { studio_management: true } }))
    await expect(LiveRedirectPage()).rejects.toThrow(/^NEXT_REDIRECT:\/live\/loc9$/)
  })

  it('redirects to / when studio_management is held but there is no active location', async () => {
    getCurrentUser.mockResolvedValue(user({ activeLocationId: null, perms: { studio_management: true } }))
    await expect(LiveRedirectPage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
})
