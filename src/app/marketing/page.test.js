// HUBS.2f — /marketing hub index. Mirrors src/app/operations/page.test.js
// (HUBS.2e) exactly: hoisted vi.mock for @/lib/auth + next/navigation
// (redirect throws NEXT_REDIRECT:<url>, matching production behaviour).
// Permissions are NOT mocked — the fixture drives the real resolver
// (hasPermission → shared/permissions.js resolvePermission) via
// activeAssignment.permissions overrides, the same fixture shape used
// by src/lib/dashboard-redirect.test.js's `user()` factory (role +
// activeLocation + activeAssignment.permissions). Every fixture below
// sets all six gate keys EXPLICITLY — role defaults for staff grant
// many of them, so an omitted key would pass for the wrong reason.
//
// Chain order (automations/email/whatsapp/device_control first — the
// /automations page itself gates on that same OR, VERIFIED by reading
// the page: canCurated || canFlows || canDevices, where canDevices is
// device_control alone — a device_control-only holder sees the Tapo
// section rendered by /automations/devices and would otherwise
// dead-end at this index's fallback; then landing_page) and the final
// fallback ('/', unlike /team's universal-access /policies —
// Marketing has no open-to-all tab) both come straight from the page
// brief.
//
// landing_page routes to /settings/landing-page — the in-app editor —
// NEVER to /welcome, which is the PUBLIC landing page itself and is
// never an in-app pathname (the sidebar entry for it opens a new tab).
//
// HUBDOOR.1 — `sms` is the SIXTH gate key, and it was missing from both
// the chain and this fixture. DEEP.4 Task 2 put `sms` in the Marketing
// sidebar union so an sms-only holder would get a door to the campaign
// pages, but this index had no sms branch, so that exact persona clicked
// Marketing and landed on the '/' fallback. The chain now lives in
// src/lib/hub-index-chains.js (which is also where nav-items.test.js
// checks it against the union); these cases prove it end-to-end through
// the page. `sms: false` joins allDenied so the fallback case fails for
// the right reason rather than riding on a role default.

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
// six gate keys the fixture holds, regardless of role defaults.
// ALL six keys are always passed explicitly.
function user({ role = 'staff', perms = {}, features = {} } = {}) {
  const allDenied = {
    automations: false,
    email: false,
    whatsapp: false,
    device_control: false,
    landing_page: false,
    sms: false,
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
    await expect(MarketingIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('redirects to /automations when automations is held (others denied)', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { automations: true } })
    )
    await expect(MarketingIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/automations$/)
  })

  it('redirects to /automations when only email is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { email: true } })
    )
    await expect(MarketingIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/automations$/)
  })

  it('redirects to /automations when only device_control is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { device_control: true } })
    )
    await expect(MarketingIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/automations$/)
  })

  it('redirects to /settings/landing-page when only landing_page is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { landing_page: true } })
    )
    await expect(MarketingIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/settings\/landing-page$/)
  })

  it('redirects to /communications/send when only sms is held (HUBDOOR.1 — this persona used to bounce to /)', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { sms: true } })
    )
    await expect(MarketingIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/communications\/send$/)
  })

  it('sms stays behind automations and landing_page in the chain (tab order)', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { sms: true, automations: true } })
    )
    await expect(MarketingIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/automations$/)
    getCurrentUser.mockResolvedValue(
      user({ perms: { sms: true, landing_page: true } })
    )
    await expect(MarketingIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/settings\/landing-page$/)
  })

  // Anchored: 'NEXT_REDIRECT:/' as a bare string is a SUBSTRING of every
  // other target, so an unanchored fallback assertion passes against any
  // redirect at all — see src/app/operations/page.test.js's header for the
  // gap that hid behind exactly this.
  it('redirects to / when none of the six keys are held', async () => {
    getCurrentUser.mockResolvedValue(user())
    await expect(MarketingIndexPage()).rejects.toThrow(/NEXT_REDIRECT:\/$/)
  })

  // device_control deliberately left denied here (the fixture default) —
  // the location gate below only denies automations/email/whatsapp, so
  // granting device_control too would light the /automations branch for
  // a reason this test isn't trying to exercise.
  it('redirects to /settings/landing-page when the location gate denies automations + email + whatsapp for everyone, even with those permissions plus landing_page held', async () => {
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
    await expect(MarketingIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/settings\/landing-page$/)
  })
})
