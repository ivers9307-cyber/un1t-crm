// TPL-IDOR.1 — /whatsapp/templates/[id] page guard (2026-08-09 comms audit).
//
// Twin of src/app/email/templates/[id]/page.test.js: the page fetches
// whatsapp_templates by bare id on the service-role client, so app code is
// the ONLY access check. A template at a location outside the user's
// assignments must 404 via notFound() (404 not 403 — foreign ids stay
// non-enumerable), mirroring email/campaigns/[id]/page.js.

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

vi.mock('@/components/WATemplateEditor', () => ({
  default: () => null,
}))

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

import EditWATemplatePage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { notFound } from 'next/navigation'

// The page hits two tables: whatsapp_templates (fetch-by-id → single) and
// whatsapp_template_events (history list → order → limit). Dispatch on the
// table name.
function mockDb({ template = null, events = [] } = {}) {
  return {
    from: vi.fn((table) => {
      if (table === 'whatsapp_templates') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: template,
                error: template ? null : { message: 'not found' },
              })),
            })),
          })),
        }
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn(async () => ({ data: events, error: null })),
            })),
          })),
        })),
      }
    }),
  }
}

const user = {
  id: 'user-1',
  locations: [{ id: 'loc-mine' }],
  activeLocation: { id: 'loc-mine' },
}

function props(id = 'wa-tpl-1') {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => vi.clearAllMocks())

describe('/communications/templates/whatsapp/[id] page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(EditWATemplatePage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('404s a template at a location outside the user assignments (IDOR)', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(
      mockDb({ template: { id: 'wa-tpl-1', location_id: 'loc-foreign', body_text: 'secret' } })
    )
    await expect(EditWATemplatePage(props())).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalled()
  })

  it('404s a missing template', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(mockDb({ template: null }))
    await expect(EditWATemplatePage(props())).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('renders the editor for a template at an assigned location', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(
      mockDb({ template: { id: 'wa-tpl-1', location_id: 'loc-mine' } })
    )
    const el = await EditWATemplatePage(props())
    expect(el).toBeTruthy()
    expect(notFound).not.toHaveBeenCalled()
  })

  it('allows a template with no location_id (parity with the email twin)', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(
      mockDb({ template: { id: 'wa-tpl-1', location_id: null } })
    )
    const el = await EditWATemplatePage(props())
    expect(el).toBeTruthy()
    expect(notFound).not.toHaveBeenCalled()
  })
})
