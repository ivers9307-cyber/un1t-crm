// MCP.1 — /oauth/consent server page.
//
// Supabase Auth's OAuth server sends a person here (Authorization Path
// /oauth/consent) with ?authorization_id=…. The page decides who may even be
// offered the Approve button (the org switch + the assistant permission) and
// hands that to the client form; the form talks to Supabase from the browser.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getCurrentUser = vi.fn()
const hasPermissionAtAnyLocation = vi.fn()
const mcpEnabledOrgIds = vi.fn()
const db = { tag: 'service-role-db' }

vi.mock('next/navigation', () => ({
  redirect: (url) => { throw Object.assign(new Error('NEXT_REDIRECT'), { url }) },
}))
vi.mock('@/lib/auth', () => ({ getCurrentUser: (...a) => getCurrentUser(...a) }))
vi.mock('@/lib/permissions', () => ({ hasPermissionAtAnyLocation: (...a) => hasPermissionAtAnyLocation(...a) }))
vi.mock('@/lib/mcp/auth', () => ({ mcpEnabledOrgIds: (...a) => mcpEnabledOrgIds(...a) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/components/OAuthConsentForm', () => ({
  default: function OAuthConsentForm() { return null },
}))

import OAuthConsentForm from '@/components/OAuthConsentForm'
import ConsentPage from './page.js'

const USER = { id: 'u1', email: 'coach@example.test', full_name: 'Casey Coach', locations: [{ id: 'l1', organization_id: 'o1' }] }

// Walk the returned element tree for the form element.
function findForm(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === OAuthConsentForm) return node
  const kids = node.props?.children
  for (const k of Array.isArray(kids) ? kids : [kids]) {
    const hit = findForm(k)
    if (hit) return hit
  }
  return null
}

const render = (authorization_id) => ConsentPage({
  searchParams: Promise.resolve(authorization_id === undefined ? {} : { authorization_id }),
})

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(USER)
  mcpEnabledOrgIds.mockResolvedValue(['o1'])
  hasPermissionAtAnyLocation.mockReturnValue(true)
})

describe('/oauth/consent page', () => {
  it('redirects to /login with the consent path preserved when signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(render('abc-123')).rejects.toMatchObject({
      url: '/login?redirect=' + encodeURIComponent('/oauth/consent?authorization_id=abc-123'),
    })
  })

  it('encodes an awkward authorization_id so the redirect cannot be bent', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(render('a&b=c d')).rejects.toMatchObject({
      url: '/login?redirect=' + encodeURIComponent('/oauth/consent?authorization_id=' + encodeURIComponent('a&b=c d')),
    })
  })

  it('says the link is incomplete when authorization_id is missing', async () => {
    const out = await render(undefined)
    expect(findForm(out)).toBe(null)
    expect(JSON.stringify(out)).toContain('This link is incomplete')
    expect(getCurrentUser).not.toHaveBeenCalled()
  })

  it('passes eligibility ok when an org has MCP on and the assistant permission is held', async () => {
    const form = findForm(await render('abc'))
    expect(form.props).toMatchObject({
      authorizationId: 'abc',
      eligibility: { ok: true, reason: null },
      personName: 'Casey Coach',
    })
    expect(mcpEnabledOrgIds).toHaveBeenCalledWith(db, USER)
    expect(hasPermissionAtAnyLocation).toHaveBeenCalledWith(USER, 'assistant')
  })

  it('passes eligibility mcp_disabled when no org has it on', async () => {
    mcpEnabledOrgIds.mockResolvedValue([])
    const form = findForm(await render('abc'))
    expect(form.props.eligibility).toEqual({ ok: false, reason: 'mcp_disabled' })
  })

  it('passes eligibility assistant_permission when the permission is held nowhere', async () => {
    hasPermissionAtAnyLocation.mockReturnValue(false)
    const form = findForm(await render('abc'))
    expect(form.props.eligibility).toEqual({ ok: false, reason: 'assistant_permission' })
  })

  it('reports the org switch first when both refusals apply', async () => {
    mcpEnabledOrgIds.mockResolvedValue([])
    hasPermissionAtAnyLocation.mockReturnValue(false)
    const form = findForm(await render('abc'))
    expect(form.props.eligibility.reason).toBe('mcp_disabled')
  })
})
