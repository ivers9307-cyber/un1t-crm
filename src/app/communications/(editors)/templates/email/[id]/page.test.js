// TPL-IDOR.1 — /email/templates/[id] page guard (2026-08-09 comms audit).
//
// The page fetches email_templates by bare id on the service-role client,
// so app code is the ONLY access check. It must mirror the campaign detail
// page (email/campaigns/[id]/page.js): after the fetch, a template at a
// location outside the user's assignments 404s via notFound() — 404 not
// 403, so foreign ids aren't enumerable.
//
// Same pattern as src/app/api/orders/[id]/route.test.js: hoisted vi.mock
// for auth (faithful assertLocationAccess reimplementation) + supabase,
// then call the page function with fabricated props.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: (user, locationId) => {
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    }
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) {
      return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 })
    }
    return null
  },
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}))

vi.mock('@/components/TemplateEditor', () => ({
  default: () => null,
}))

// next/navigation's real notFound()/redirect() throw — model that, so the
// page stops executing at the guard exactly like it does in production.
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    const err = new Error('NEXT_NOT_FOUND')
    err.digest = 'NEXT_NOT_FOUND'
    throw err
  }),
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
}))

import EditTemplatePage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { notFound } from 'next/navigation'

function mockDb({ template = null, error = null } = {}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: error ? null : template, error })),
        })),
      })),
    })),
  }
}

// GATES-2 — the page now also asks `email` at the template's studio, so the
// caller is an owner there (owners hold `email` by default).
const user = {
  id: 'user-1',
  role: 'owner',
  locations: [{ id: 'loc-mine', role: 'owner', features: {} }],
  assignmentsByLocation: { 'loc-mine': { role: 'owner', permissions: {} } },
  activeLocation: { id: 'loc-mine', features: {} },
}

function props(id = 'tpl-1') {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => vi.clearAllMocks())

describe('/communications/templates/email/[id] page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(EditTemplatePage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('404s a template at a location outside the user assignments (IDOR)', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(
      mockDb({ template: { id: 'tpl-1', location_id: 'loc-foreign', html_content: '<p>secret</p>' } })
    )
    await expect(EditTemplatePage(props())).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalled()
  })

  it('404s a missing template', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(mockDb({ template: null }))
    await expect(EditTemplatePage(props())).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('renders the editor for a template at an assigned location', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(
      mockDb({ template: { id: 'tpl-1', location_id: 'loc-mine' } })
    )
    const el = await EditTemplatePage(props())
    expect(el).toBeTruthy()
    expect(notFound).not.toHaveBeenCalled()
  })

  // C123 GATES-4 (c) — a template with no location_id opened here but its
  // save (PUT /api/templates/[id]) 404s, so the page now 404s too (0 such
  // rows in prod; no data change). Main: rendered the editor.
  it('404s a template with no location_id (parity with PUT /api/templates/[id])', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(
      mockDb({ template: { id: 'tpl-1', location_id: null } })
    )
    await expect(EditTemplatePage(props())).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalled()
  })

  it('a failed read is an error, not "not found"', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(mockDb({ error: { code: '57014', message: 'timeout' } }))
    await expect(EditTemplatePage(props())).rejects.toThrow(/could not be read/)
    expect(notFound).not.toHaveBeenCalled()
  })
})
