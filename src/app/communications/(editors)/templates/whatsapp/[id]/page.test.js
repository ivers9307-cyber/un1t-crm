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

// GATES-2 — the page's area gate (the old layout rule, now per page) is
// covered by tests/communications-pages-gate.test.js; these role-only fixtures
// carry no per-location permission data, so it passes here.
vi.mock('@/lib/communications-access', () => ({
  canUseCommunicationsHere: () => true,
  canUseCommunicationsForRecord: () => true,
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
import { LOC_A, LOC_B, person, MASTER } from '../../../../../../../tests/helpers/owner-at-location-callers.js'

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

// WATPLROLE.1 — resubmit, edit and delete decide MANAGER_ROLES at the
// TEMPLATE's location, so the editor's canManage is judged there too, never
// on the active studio's role.
describe('/communications/templates/whatsapp/[id] — canManage at the template\'s location (WATPLROLE.1)', () => {
  it.each([
    ['a manager there: can manage', person({ [LOC_B]: 'manager' }, LOC_B), true],
    ['a head coach there: can manage', person({ [LOC_B]: 'head_coach' }, LOC_B), true],
    ['staff at the active studio, manager at the template\'s: can manage', person({ [LOC_A]: 'staff', [LOC_B]: 'manager' }, LOC_A), true],
    ['a master: can manage', MASTER, true],
    ['staff there: cannot', person({ [LOC_B]: 'staff' }, LOC_B), false],
    ['a manager at the active studio who is staff at the template\'s: cannot', person({ [LOC_A]: 'manager', [LOC_B]: 'staff' }, LOC_A), false],
    // GATES-3 (b) — the routes also ask `whatsapp` at the template's studio.
    ['a manager there with WhatsApp switched off for them there: cannot', {
      ...person({ [LOC_A]: 'manager', [LOC_B]: 'manager' }, LOC_A),
      assignmentsByLocation: {
        [LOC_A]: { role: 'manager', permissions: {} },
        [LOC_B]: { role: 'manager', permissions: { whatsapp: false } },
      },
    }, false],
  ])('%s', async (_label, caller, expected) => {
    getCurrentUser.mockResolvedValue(caller)
    createServerClient.mockReturnValue(mockDb({ template: { id: 'wa-tpl-1', location_id: LOC_B } }))
    const el = await EditWATemplatePage(props())
    expect(el.props.canManage).toBe(expected)
  })
})

// WATPLPUT.1 — the editor gets the TEMPLATE's location, never the active
// studio's: it loads group suggestions and signs header-media uploads (with
// that location's own WhatsApp number) from it.
describe('/communications/templates/whatsapp/[id] — the editor works at the template\'s location (WATPLPUT.1)', () => {
  it.each([
    ['active studio is another one', person({ [LOC_A]: 'manager', [LOC_B]: 'manager' }, LOC_A)],
    ['active studio is the template\'s', person({ [LOC_B]: 'manager' }, LOC_B)],
    ['a master with another active studio', MASTER],
  ])('%s: locationId is the template\'s', async (_label, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    createServerClient.mockReturnValue(mockDb({ template: { id: 'wa-tpl-1', location_id: LOC_B } }))
    const el = await EditWATemplatePage(props())
    expect(el.props.locationId).toBe(LOC_B)
  })
})
