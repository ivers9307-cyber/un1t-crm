// HUBS.2a — /sales hub index. The sidebar's single Sales entry points
// here; the hub's real surfaces keep their existing URLs (/pipeline,
// /contacts, /activities). This page just redirects to the first tab
// the signed-in user's permissions allow, in that priority order.
//
// Mocking style mirrors src/app/communications/(editors)/templates/email/[id]/page.test.js:
// hoisted vi.mock for @/lib/auth + next/navigation (redirect throws
// NEXT_REDIRECT:<url>, matching production behaviour).
//
// Permissions are NOT mocked — the fixture drives the real resolver
// (hasPermission → shared/permissions.js resolvePermission) via
// activeAssignment.permissions overrides, the same fixture shape used
// by src/lib/dashboard-redirect.test.js's `user()` factory (role +
// activeLocation + activeAssignment.permissions).

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

import SalesIndexPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

// Stable user fixture — explicit per-user permission overrides
// (tier 2 of the resolver) so each test controls exactly which of
// pipeline/contacts/activities the fixture holds, regardless of role
// defaults.
function user({ role = 'staff', perms = {} } = {}) {
  return {
    id: 'u1',
    role,
    activeLocation: { id: 'loc1', features: {} },
    activeAssignment: { permissions: { ...perms } },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('/sales index page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(SalesIndexPage()).rejects.toThrow('NEXT_REDIRECT:/login')
  })

  it('redirects to /pipeline when the user holds pipeline (+ others)', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { pipeline: true, contacts: true, activities: true } })
    )
    await expect(SalesIndexPage()).rejects.toThrow('NEXT_REDIRECT:/pipeline')
  })

  it('redirects to /contacts when pipeline is absent but contacts is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { pipeline: false, contacts: true, activities: true } })
    )
    await expect(SalesIndexPage()).rejects.toThrow('NEXT_REDIRECT:/contacts')
  })

  it('redirects to /activities when only activities is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { pipeline: false, contacts: false, activities: true } })
    )
    await expect(SalesIndexPage()).rejects.toThrow('NEXT_REDIRECT:/activities')
  })

  it('redirects to / when none of the three are held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { pipeline: false, contacts: false, activities: false } })
    )
    await expect(SalesIndexPage()).rejects.toThrow(/NEXT_REDIRECT:\/$/)
  })

  it('redirects to /contacts when the location gate denies pipeline for everyone, even with pipeline permission held', async () => {
    const u = user({ perms: { pipeline: true, contacts: true, activities: true } })
    u.activeLocation = { id: 'loc1', features: { pipeline: false } }
    getCurrentUser.mockResolvedValue(u)
    await expect(SalesIndexPage()).rejects.toThrow('NEXT_REDIRECT:/contacts')
  })
})
