// HUBS.2f — /marketing hub index. Mirrors src/app/operations/page.test.js
// (HUBS.2e) exactly: hoisted vi.mock for @/lib/auth + next/navigation
// (redirect throws NEXT_REDIRECT:<url>, matching production behaviour).
// Permissions are NOT mocked — the fixture drives the real resolver
// (hasPermission → shared/permissions.js resolvePermission) via
// activeAssignment.permissions overrides, the same fixture shape used
// by src/lib/dashboard-redirect.test.js's `user()` factory (role +
// activeLocation + activeAssignment.permissions). Every fixture below
// sets all four gate keys EXPLICITLY — role defaults for staff grant
// many of them, so an omitted key would pass for the wrong reason.
//
// Chain order (automations/email/whatsapp first — the /automations
// page itself gates on that same OR, VERIFIED by reading the page —
// then landing_page) and the final fallback ('/', unlike /team's
// universal-access /policies — Marketing has no open-to-all tab) both
// come straight from the page brief.
//
// landing_page routes to /settings/landing-page — the in-app editor —
// NEVER to /welcome, which is the PUBLIC landing page itself and is
// never an in-app pathname (the sidebar entry for it opens a new tab).

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

import MarketingIndexPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

// Stable user fixture — explicit per-user permission overrides
// (tier 2 of the resolver) so each test controls exactly which of the
// four gate keys the fixture holds, regardless of role defaults.
// ALL four keys are always passed explicitly.
function user({ role = 'staff', perms = {}, features = {} } = {}) {
  const allDenied = {
    automations: false,
    email: false,
    whatsapp: false,
    landing_page: false,
  }
  return {
    id: 'u1',
    role,
    activeLocation: { id: 'loc1', features },
    activeAssignment: { permissions: { ...allDenied, ...perms } },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('/marketing index page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(MarketingIndexPage()).rejects.toThrow('NEXT_REDIRECT:/login')
  })

  it('redirects to /automations when automations is held (others denied)', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { automations: true } })
    )
    await expect(MarketingIndexPage()).rejects.toThrow('NEXT_REDIRECT:/automations')
  })

  it('redirects to /automations when only email is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { email: true } })
    )
    await expect(MarketingIndexPage()).rejects.toThrow('NEXT_REDIRECT:/automations')
  })

  it('redirects to /settings/landing-page when only landing_page is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { landing_page: true } })
    )
    await expect(MarketingIndexPage()).rejects.toThrow('NEXT_REDIRECT:/settings/landing-page')
  })

  it('redirects to / when none of the four keys are held', async () => {
    getCurrentUser.mockResolvedValue(user())
    await expect(MarketingIndexPage()).rejects.toThrow('NEXT_REDIRECT:/')
  })

  it('redirects to /settings/landing-page when the location gate denies automations + email + whatsapp for everyone, even with all four permissions held', async () => {
    const u = user({
      perms: {
        automations: true,
        email: true,
        whatsapp: true,
        landing_page: true,
      },
      features: { automations: false, email: false, whatsapp: false },
    })
    getCurrentUser.mockResolvedValue(u)
    await expect(MarketingIndexPage()).rejects.toThrow('NEXT_REDIRECT:/settings/landing-page')
  })
})
