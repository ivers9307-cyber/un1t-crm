// SETTINGS.2g — server gate for /settings/customer-agent. The page was a
// bare 'use client' component with no server-side check at all — it relied
// entirely on its API routes (GET/PUT /api/settings/customer-agent, GET/POST
// /api/agent/knowledge) 401/403ing after the shell had already loaded. This
// mirrors the write path's role check: PUT /api/settings/customer-agent and
// POST /api/agent/knowledge both gate on MANAGER_ROLES (the page's own
// header comment already said "Manager+ only" — the code just never
// enforced it). Pattern follows src/app/settings/usage/page.js: signed-out
// -> /login, non-holder -> /settings (settings-family convention).

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

// Client component stub — this test asserts on the server-side gate only.
vi.mock('./CustomerAgentClient', () => ({
  default: ({ canEdit }) => <div>customer-agent-client-rendered can-edit={String(canEdit)}</div>,
}))

import CustomerAgentSettingsPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

function user(role, rolesByLocation = role === 'master' ? {} : { loc1: role }) {
  return { id: 'u1', role, profileRole: role === 'master' ? 'master' : 'staff', activeLocation: { id: 'loc1' }, rolesByLocation }
}

const ALL_ROLES = ['master', 'owner', 'manager', 'head_coach', 'staff']
const NON_MANAGER_ROLES = ALL_ROLES.filter((r) => !MANAGER_ROLES.includes(r))

beforeEach(() => vi.clearAllMocks())

describe('/settings/customer-agent page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(CustomerAgentSettingsPage()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  for (const role of NON_MANAGER_ROLES) {
    it(`redirects to /settings for role "${role}" (not manager+)`, async () => {
      getCurrentUser.mockResolvedValue(user(role))
      await expect(CustomerAgentSettingsPage()).rejects.toThrow(/^NEXT_REDIRECT:\/settings$/)
    })
  }

  for (const role of MANAGER_ROLES) {
    it(`renders the client component for role "${role}" (manager+)`, async () => {
      getCurrentUser.mockResolvedValue(user(role))
      const html = renderToStaticMarkup(await CustomerAgentSettingsPage())
      expect(html).toContain('customer-agent-client-rendered')
    })
  }

  // MIAROLE.1 (C80) — reads stay manager+; only an owner AT the active studio
  // (or a master) gets the editable form. Same predicate as the PUT's gate.
  for (const [label, u, expected] of [
    ['an owner at the studio', user('owner'), 'true'],
    ['a master', user('master'), 'true'],
    ['a manager', user('manager'), 'false'],
    ['a head coach', user('head_coach'), 'false'],
    ['an owner at ANOTHER studio (manager here)', user('owner', { loc1: 'manager', loc2: 'owner' }), 'false'],
  ]) {
    it(`${label}: canEdit=${expected}`, async () => {
      getCurrentUser.mockResolvedValue(u)
      const html = renderToStaticMarkup(await CustomerAgentSettingsPage())
      expect(html).toContain(`can-edit=${expected}`)
    })
  }
})
