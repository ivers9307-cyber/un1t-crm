// SETTINGS.2g — server gate for /settings/customer-agent/requests. Bare
// 'use client' component with no server-side check, relying entirely on
// GET /api/agent/membership-requests (no conversation_id — the full-history
// branch this page's initial load hits) 403ing after the shell loaded.
// Mirrors that branch's MANAGER_ROLES check exactly (the page's own header
// comment already said "Manager+ reviews the pause / cancellation
// requests"). Signed-out -> /login, non-holder -> /settings (settings-
// family convention, same as src/app/settings/usage/page.js).
//
// Note: the per-row decide action (PATCH /api/agent/membership-requests/
// [id]) gates on a separate per-category permission
// (APPROVAL_CATEGORY_PERMISSION.agent_requests), deliberately broader than
// MANAGER_ROLES — but that only governs the decide button, not landing on
// the page and loading the queue, so it's out of scope for this page gate.

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

vi.mock('./AgentRequestsClient', () => ({
  default: () => <div>agent-requests-client-rendered</div>,
}))

import AgentRequestsPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

function user(role) {
  return { id: 'u1', role, activeLocation: { id: 'loc1' } }
}

const ALL_ROLES = ['master', 'owner', 'manager', 'head_coach', 'staff']
const NON_MANAGER_ROLES = ALL_ROLES.filter((r) => !MANAGER_ROLES.includes(r))

beforeEach(() => vi.clearAllMocks())

describe('/settings/customer-agent/requests page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(AgentRequestsPage()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  for (const role of NON_MANAGER_ROLES) {
    it(`redirects to /settings for role "${role}" (not manager+)`, async () => {
      getCurrentUser.mockResolvedValue(user(role))
      await expect(AgentRequestsPage()).rejects.toThrow(/^NEXT_REDIRECT:\/settings$/)
    })
  }

  for (const role of MANAGER_ROLES) {
    it(`renders the client component for role "${role}" (manager+)`, async () => {
      getCurrentUser.mockResolvedValue(user(role))
      const html = renderToStaticMarkup(await AgentRequestsPage())
      expect(html).toContain('agent-requests-client-rendered')
    })
  }
})
