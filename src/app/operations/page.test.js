// HUBS.2e — /operations hub index. Mirrors src/app/team/page.test.js
// (HUBS.2d) exactly: hoisted vi.mock for @/lib/auth + next/navigation
// (redirect throws NEXT_REDIRECT:<url>, matching production behaviour).
// Permissions are NOT mocked — the fixture drives the real resolver
// (hasPermission → shared/permissions.js resolvePermission) via
// activeAssignment.permissions overrides, the same fixture shape used
// by src/lib/dashboard-redirect.test.js's `user()` factory (role +
// activeLocation + activeAssignment.permissions). Every fixture below
// sets all seven gate keys EXPLICITLY — role defaults for staff grant
// many of them, so an omitted key would pass for the wrong reason.
//
// Chain order (maintenance first — the daily surface — then the
// door/devices panel, displays, presentations, and Fleet last) and the
// final fallback ('/', unlike /team's universal-access /policies —
// Operations has no open-to-all tab) both come straight from the page
// brief. The chain itself now lives in src/lib/hub-index-chains.js, where
// nav-items.test.js checks it against the sidebar union.
//
// HUBDOOR.1 — TWO bugs met in this file. (1) fleet_restart/fleet_admin
// were in the Operations sidebar union (ADMIN.2h Task 2's review fix, for
// a fleet-only persona) but in no branch of the index, so that persona
// clicked Operations and bounced. (2) This suite could not have caught it:
// `.rejects.toThrow('NEXT_REDIRECT:/')` is a SUBSTRING match, so the
// fallback case passed against ANY redirect target — and it was passing
// on '/admin/fleet' by accident, since fleet_restart defaults ON for every
// role and the fixture never denied it. The fallback assertions below are
// now anchored regexes, and both fleet keys joined allDenied.

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
// seven gate keys the fixture holds, regardless of role defaults.
// ALL seven keys are always passed explicitly.
function user({ role = 'staff', perms = {}, features = {} } = {}) {
  const allDenied = {
    equipment_admin: false,
    equipment_inspect: false,
    studio_management: false,
    tv_displays: false,
    presentations: false,
    fleet_restart: false,
    fleet_admin: false,
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

  it('redirects to /admin/fleet when only fleet_restart is held (HUBDOOR.1 — this persona used to bounce to /)', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { fleet_restart: true } })
    )
    await expect(OperationsIndexPage()).rejects.toThrow('NEXT_REDIRECT:/admin/fleet')
  })

  it('redirects to /admin/fleet when only fleet_admin is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { fleet_admin: true } })
    )
    await expect(OperationsIndexPage()).rejects.toThrow('NEXT_REDIRECT:/admin/fleet')
  })

  it('fleet is LAST in the chain — any in-hub tab still wins', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { fleet_admin: true, presentations: true } })
    )
    await expect(OperationsIndexPage()).rejects.toThrow('NEXT_REDIRECT:/presentations')
  })

  // Anchored: 'NEXT_REDIRECT:/' as a bare string is a substring of every
  // other target, which is how the fleet gap hid here for a whole PR.
  it('redirects to / when none of the seven keys are held', async () => {
    getCurrentUser.mockResolvedValue(user())
    await expect(OperationsIndexPage()).rejects.toThrow(/NEXT_REDIRECT:\/$/)
  })

  it('redirects to /studio-management when the location gate denies equipment_admin + equipment_inspect for everyone, even with all five in-hub permissions held', async () => {
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
