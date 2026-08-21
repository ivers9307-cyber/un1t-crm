// ADMIN.2h — SEC fix. /admin/health had NO page-level gate at all: its
// header comment claimed it "inherits the master-only gate from
// /admin/layout.js", but that layout has never been hard master-only
// (STUDIO-GROUP.1 already relaxed it for Studio Management perm
// holders, and ADMIN.2h Task 3 relaxed it further for owner +
// fleet_restart/fleet_admin). Anyone who could get past the layout —
// which, post-Task-3, includes nearly any staff/reception role via the
// fleet permission bypass — could load this page and see cross-tenant
// platform health: org-wide integration errors, AI spend, heartbeats.
// Pattern follows the settings-family idiom (src/app/settings/
// customer-agent/page.test.js): mock getCurrentUser + next/navigation's
// redirect (throws NEXT_REDIRECT so an unreached `return` is provable),
// mock the data layer so no DB is touched, assert signed-out -> /login,
// every non-master role -> /, master -> renders.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

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

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(() => ({})),
}))

vi.mock('@/lib/tenant-health', () => ({
  getTenantHealth: vi.fn(),
}))

import TenantHealthPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { getTenantHealth } from '@/lib/tenant-health'

function user(role, profileRole = role) {
  return { id: 'u1', role, profileRole, activeLocation: { id: 'loc1' } }
}

const ALL_ROLES = ['master', 'owner', 'manager', 'head_coach', 'staff']
const NON_MASTER_ROLES = ALL_ROLES.filter((r) => r !== 'master')

beforeEach(() => {
  vi.clearAllMocks()
  getTenantHealth.mockResolvedValue([])
})

describe('/admin/health page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(TenantHealthPage()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  for (const role of NON_MASTER_ROLES) {
    it(`redirects to / for role "${role}" (not master — matches the sibling /admin pages)`, async () => {
      getCurrentUser.mockResolvedValue(user(role))
      await expect(TenantHealthPage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
      // Never reaches the data layer for a rejected role.
      expect(getTenantHealth).not.toHaveBeenCalled()
    })
  }

  it('renders for master', async () => {
    getCurrentUser.mockResolvedValue(user('master'))
    const html = renderToStaticMarkup(await TenantHealthPage())
    expect(html).toContain('Tenant health')
    expect(getTenantHealth).toHaveBeenCalledTimes(1)
  })

  it('a non-master role impersonating an active-location "master" role string still redirects (profileRole is canonical, not the per-location role)', async () => {
    // role flips per active location; profileRole is the global source of
    // truth every sibling /admin page reads. Guard against a gate that
    // accidentally reads `user.role` instead.
    getCurrentUser.mockResolvedValue(user('master', 'owner'))
    await expect(TenantHealthPage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
})
