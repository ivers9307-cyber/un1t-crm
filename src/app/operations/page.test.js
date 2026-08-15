// HUBS.2e — /operations hub index. Mirrors src/app/team/page.test.js
// (HUBS.2d) exactly: hoisted vi.mock for @/lib/auth + next/navigation
// (redirect throws NEXT_REDIRECT:<url>, matching production behaviour).
// Permissions are NOT mocked — the fixture drives the real resolver
// (hasPermission → shared/permissions.js resolvePermission) via
// activeAssignment.permissions overrides, the same fixture shape used
// by src/lib/dashboard-redirect.test.js's `user()` factory (role +
// activeLocation + activeAssignment.permissions). Every fixture below
// sets all five gate keys EXPLICITLY — role defaults for staff grant
// many of them, so an omitted key would pass for the wrong reason.
//
// Chain order (maintenance first — the daily surface — then the
// door/devices panel, displays, presentations) and the final fallback
// ('/', unlike /team's universal-access /policies — Operations has no
// open-to-all tab) both come straight from the page brief.

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

import OperationsIndexPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

// Stable user fixture — explicit per-user permission overrides
// (tier 2 of the resolver) so each test controls exactly which of the
// five gate keys the fixture holds, regardless of role defaults.
// ALL five keys are always passed explicitly.
function user({ role = 'staff', perms = {}, features = {} } = {}) {
  const allDenied = {
    equipment_admin: false,
    equipment_inspect: false,
    studio_management: false,
    tv_displays: false,
    presentations: false,
  }
  return {
    id: 'u1',
    role,
    activeLocation: { id: 'loc1', features },
    activeAssignment: { permissions: { ...allDenied, ...perms } },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('/operations index page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(OperationsIndexPage()).rejects.toThrow('NEXT_REDIRECT:/login')
  })

  it('redirects to /maintenance when equipment_admin is held (others denied)', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { equipment_admin: true } })
    )
    await expect(OperationsIndexPage()).rejects.toThrow('NEXT_REDIRECT:/maintenance')
  })

  it('redirects to /maintenance when only equipment_inspect is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { equipment_inspect: true } })
    )
    await expect(OperationsIndexPage()).rejects.toThrow('NEXT_REDIRECT:/maintenance')
  })

  it('redirects to /studio-management when only studio_management is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { studio_management: true } })
    )
    await expect(OperationsIndexPage()).rejects.toThrow('NEXT_REDIRECT:/studio-management')
  })

  it('redirects to /tv-displays when only tv_displays is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { tv_displays: true } })
    )
    await expect(OperationsIndexPage()).rejects.toThrow('NEXT_REDIRECT:/tv-displays')
  })

  it('redirects to /presentations when only presentations is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { presentations: true } })
    )
    await expect(OperationsIndexPage()).rejects.toThrow('NEXT_REDIRECT:/presentations')
  })

  it('redirects to / when none of the five keys are held', async () => {
    getCurrentUser.mockResolvedValue(user())
    await expect(OperationsIndexPage()).rejects.toThrow('NEXT_REDIRECT:/')
  })

  it('redirects to /studio-management when the location gate denies equipment_admin + equipment_inspect for everyone, even with all five permissions held', async () => {
    const u = user({
      perms: {
        equipment_admin: true,
        equipment_inspect: true,
        studio_management: true,
        tv_displays: true,
        presentations: true,
      },
      features: { equipment_admin: false, equipment_inspect: false },
    })
    getCurrentUser.mockResolvedValue(u)
    await expect(OperationsIndexPage()).rejects.toThrow('NEXT_REDIRECT:/studio-management')
  })
})
