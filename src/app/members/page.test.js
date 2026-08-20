// HUBS.2b — /members hub index. The sidebar's single Members entry
// points here; the hub's real surfaces keep their existing URLs
// (/bookings, /events, /challenges, /pulse, /live,
// /studio-management/timer, /hyrox). This page just redirects to the
// first tab the signed-in user's permissions allow, in that priority
// order. Gate keys mirror each PAGE's own gate (bookings page checks
// `bookings`, events checks `races`, etc.), not the old nav entries'
// looser gates.
//
// Mirrors src/app/sales/page.test.js (HUBS.2a) exactly: hoisted
// vi.mock for @/lib/auth + next/navigation (redirect throws
// NEXT_REDIRECT:<url>, matching production behaviour). Permissions are
// NOT mocked — the fixture drives the real resolver (hasPermission →
// shared/permissions.js resolvePermission) via
// activeAssignment.permissions overrides, the same fixture shape used
// by src/lib/dashboard-redirect.test.js's `user()` factory (role +
// activeLocation + activeAssignment.permissions). Every fixture below
// sets all seven gate keys EXPLICITLY — role defaults for staff grant
// many of them, so an omitted key would pass for the wrong reason.

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

import MembersIndexPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

// Stable user fixture — explicit per-user permission overrides
// (tier 2 of the resolver) so each test controls exactly which of the
// seven gate keys the fixture holds, regardless of role defaults.
// ALL seven keys are always passed explicitly.
function user({ role = 'staff', perms = {} } = {}) {
  const allDenied = {
    bookings: false,
    races: false,
    challenges: false,
    pulse_admin: false,
    studio_management: false,
    class_timer: false,
    approvals_hyrox_sessions: false,
  }
  return {
    id: 'u1',
    role,
    activeLocation: { id: 'loc1', features: {} },
    activeAssignment: { permissions: { ...allDenied, ...perms } },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('/members index page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(MembersIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('redirects to /bookings when all seven keys are granted', async () => {
    getCurrentUser.mockResolvedValue(
      user({
        perms: {
          bookings: true,
          races: true,
          challenges: true,
          pulse_admin: true,
          studio_management: true,
          class_timer: true,
          approvals_hyrox_sessions: true,
        },
      })
    )
    await expect(MembersIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/bookings$/)
  })

  it('redirects to /events when bookings is denied but the rest are granted', async () => {
    getCurrentUser.mockResolvedValue(
      user({
        perms: {
          bookings: false,
          races: true,
          challenges: true,
          pulse_admin: true,
          studio_management: true,
          class_timer: true,
          approvals_hyrox_sessions: true,
        },
      })
    )
    await expect(MembersIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/events$/)
  })

  // HUBDOOR.2 — /challenges gates on MANAGER_ROLES as well as the key
  // (canAdminChallenges, mirroring /api/challenges), so the chain step
  // carries that floor. This case used to assert the DEFECT: the fixture
  // role defaults to 'staff', and a staff holder of `challenges` was
  // being redirected into a page whose own gate refuses them.
  it('redirects to /challenges when only challenges is held, at a role that clears the floor', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'manager', perms: { challenges: true } }))
    await expect(MembersIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/challenges$/)
    getCurrentUser.mockResolvedValue(user({ role: 'head_coach', perms: { challenges: true } }))
    await expect(MembersIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/challenges$/)
  })

  it('does NOT send a staff or reception holder of challenges into that bounce', async () => {
    for (const role of ['staff', 'reception']) {
      getCurrentUser.mockResolvedValue(user({ role, perms: { challenges: true } }))
      await expect(MembersIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
    }
  })

  it('a below-floor challenges holder still takes the NEXT step they can open', async () => {
    getCurrentUser.mockResolvedValue(
      user({ role: 'staff', perms: { challenges: true, pulse_admin: true } })
    )
    await expect(MembersIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/pulse$/)
  })

  it('redirects to /pulse when only pulse_admin is held', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { pulse_admin: true } }))
    await expect(MembersIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/pulse$/)
  })

  it('redirects to /live when only studio_management is held', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { studio_management: true } }))
    await expect(MembersIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/live$/)
  })

  it('redirects to /studio-management/timer when only class_timer is held', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { class_timer: true } }))
    await expect(MembersIndexPage()).rejects.toThrow(
      /^NEXT_REDIRECT:\/studio-management\/timer$/
    )
  })

  it('redirects to /hyrox when only approvals_hyrox_sessions is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { approvals_hyrox_sessions: true } })
    )
    await expect(MembersIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/hyrox$/)
  })

  it('redirects to / when none of the seven are held', async () => {
    getCurrentUser.mockResolvedValue(user())
    await expect(MembersIndexPage()).rejects.toThrow(/NEXT_REDIRECT:\/$/)
  })

  it('redirects to /events when the location gate denies bookings for everyone, even with bookings permission held', async () => {
    const u = user({
      perms: {
        bookings: true,
        races: true,
        challenges: true,
        pulse_admin: true,
        studio_management: true,
        class_timer: true,
        approvals_hyrox_sessions: true,
      },
    })
    u.activeLocation = { id: 'loc1', features: { bookings: false } }
    getCurrentUser.mockResolvedValue(u)
    await expect(MembersIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/events$/)
  })
})
