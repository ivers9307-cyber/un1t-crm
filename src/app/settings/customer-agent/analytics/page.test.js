// SETTINGS.2g — server gate for /settings/customer-agent/analytics. Bare
// 'use client' component with no server-side check, relying entirely on
// GET /api/agent/analytics 403ing after the shell loaded. Mirrors that
// route's MANAGER_ROLES check exactly (the page's own header comment
// already said "Manager+ operator screen"). Signed-out -> /login,
// non-holder -> /settings (settings-family convention, same as
// src/app/settings/usage/page.js).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MANAGER_ROLES } from '@/lib/schemas'

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

vi.mock('./AgentAnalyticsClient', () => ({
  default: () => <div>agent-analytics-client-rendered</div>,
}))

import AgentAnalyticsPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

function user(role) {
  return { id: 'u1', role, activeLocation: { id: 'loc1' } }
}

const ALL_ROLES = ['master', 'owner', 'manager', 'head_coach', 'staff']
const NON_MANAGER_ROLES = ALL_ROLES.filter((r) => !MANAGER_ROLES.includes(r))

beforeEach(() => vi.clearAllMocks())

describe('/settings/customer-agent/analytics page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(AgentAnalyticsPage()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  for (const role of NON_MANAGER_ROLES) {
    it(`redirects to /settings for role "${role}" (not manager+)`, async () => {
      getCurrentUser.mockResolvedValue(user(role))
      await expect(AgentAnalyticsPage()).rejects.toThrow(/^NEXT_REDIRECT:\/settings$/)
    })
  }

  for (const role of MANAGER_ROLES) {
    it(`renders the client component for role "${role}" (manager+)`, async () => {
      getCurrentUser.mockResolvedValue(user(role))
      const html = renderToStaticMarkup(await AgentAnalyticsPage())
      expect(html).toContain('agent-analytics-client-rendered')
    })
  }
})
