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
  default: ({ canEdit, orgDefaults }) => (
    <div>customer-agent-client-rendered can-edit={String(canEdit)} org-defaults={JSON.stringify(orgDefaults ?? null)}</div>
  ),
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

// MIAORG.1 Task 4 (T4-E) — the organisation defaults section: decided on the
// server (resolveAdminOrgId), and only the organisation's id and name go to
// the client. Fictional ids.
describe('/settings/customer-agent page — organisation defaults (MIAORG.1 Task 4)', () => {
  const ORG_A = 'a0000000-0000-0000-0000-00000000a0a1'
  const ORG_B = 'a0000000-0000-0000-0000-00000000a0b2'
  const orgUser = (over) => ({
    ...user('owner'),
    activeLocation: { id: 'loc1', organization_id: ORG_A },
    activeOrganization: { id: ORG_A, name: 'Org A' },
    organizationsById: { [ORG_A]: { id: ORG_A, name: 'Org A', settings: { secret_token: 'x' } }, [ORG_B]: { id: ORG_B, name: 'Org B' } },
    orgAdminOrgIds: [],
    ...over,
  })
  const orgProp = (html) => {
    const m = html.replace(/&quot;/g, '"').match(/org-defaults=(\{.*?\}|null)</)
    return m && JSON.parse(m[1])
  }

  it('a master gets the active organisation (id and name only)', async () => {
    getCurrentUser.mockResolvedValue(orgUser({ role: 'master', profileRole: 'master', rolesByLocation: {} }))
    const html = renderToStaticMarkup(await CustomerAgentSettingsPage())
    expect(orgProp(html)).toEqual({ organizationId: ORG_A, organizationName: 'Org A' })
    expect(html).not.toContain('secret_token')
  })

  it('an org admin of the active organisation gets it', async () => {
    getCurrentUser.mockResolvedValue(orgUser({ orgAdminOrgIds: [ORG_A] }))
    expect(orgProp(renderToStaticMarkup(await CustomerAgentSettingsPage()))).toEqual({ organizationId: ORG_A, organizationName: 'Org A' })
  })

  it('an owner without an org admin grant sees the page exactly as before', async () => {
    getCurrentUser.mockResolvedValue(orgUser())
    expect(orgProp(renderToStaticMarkup(await CustomerAgentSettingsPage()))).toBe(null)
  })

  it('an org admin of ANOTHER organisation gets nothing here', async () => {
    getCurrentUser.mockResolvedValue(orgUser({ orgAdminOrgIds: [ORG_B] }))
    expect(orgProp(renderToStaticMarkup(await CustomerAgentSettingsPage()))).toBe(null)
  })
})
