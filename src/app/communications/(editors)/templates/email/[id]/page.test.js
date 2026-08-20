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

function mockDb({ template = null } = {}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: template,
            error: template ? null : { message: 'not found' },
          })),
        })),
      })),
    })),
  }
}

const user = {
  id: 'user-1',
  locations: [{ id: 'loc-mine' }],
  activeLocation: { id: 'loc-mine' },
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

  it('allows a template with no location_id (parity with GET /api/templates/[id])', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(
      mockDb({ template: { id: 'tpl-1', location_id: null } })
    )
    const el = await EditTemplatePage(props())
    expect(el).toBeTruthy()
    expect(notFound).not.toHaveBeenCalled()
  })
})
