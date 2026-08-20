// HUBS.2d — /team hub index. Mirrors src/app/money/page.test.js
// (HUBS.2c) exactly: hoisted vi.mock for @/lib/auth + next/navigation
// (redirect throws NEXT_REDIRECT:<url>, matching production behaviour).
// Permissions are NOT mocked — the fixture drives the real resolver
// (hasPermission → shared/permissions.js resolvePermission) via
// activeAssignment.permissions overrides, the same fixture shape used
// by src/lib/dashboard-redirect.test.js's `user()` factory (role +
// activeLocation + activeAssignment.permissions). Every fixture below
// sets both gate keys EXPLICITLY — role defaults for staff grant many
// of them, so an omitted key would pass for the wrong reason.
//
// One difference from /money: the chain never dead-ends at '/' —
// /policies is open to every signed-in user (its page gate is
// login-only), so Policies is the universal fallback, not '/'.

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

import TeamIndexPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

// Stable user fixture — explicit per-user permission overrides
// (tier 2 of the resolver) so each test controls exactly which of the
// two gate keys the fixture holds, regardless of role defaults.
// BOTH keys are always passed explicitly.
function user({ role = 'staff', perms = {} } = {}) {
  const allDenied = {
    schedule: false,
    contracts: false,
  }
  return {
    id: 'u1',
    role,
    activeLocation: { id: 'loc1', features: {} },
    activeAssignment: { permissions: { ...allDenied, ...perms } },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('/team index page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(TeamIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('redirects to /schedule when both keys are granted', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { schedule: true, contracts: true } })
    )
    await expect(TeamIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/schedule$/)
  })

  it('redirects to /contracts when schedule is denied but contracts is granted', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { schedule: false, contracts: true } })
    )
    await expect(TeamIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/contracts$/)
  })

  it('redirects to /contracts when only contracts is held', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { contracts: true } }))
    await expect(TeamIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/contracts$/)
  })

  it('redirects to /policies when neither key is held', async () => {
    getCurrentUser.mockResolvedValue(user())
    await expect(TeamIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/policies$/)
  })

  it('redirects to /contracts when the location gate denies schedule for everyone, even with schedule permission held', async () => {
    const u = user({ perms: { schedule: true, contracts: true } })
    u.activeLocation = { id: 'loc1', features: { schedule: false } }
    getCurrentUser.mockResolvedValue(u)
    await expect(TeamIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/contracts$/)
  })
})
