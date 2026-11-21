// ROUTEWRAP.R13 — six more WhatsApp staff routes moved onto withAuth in the
// sign-in-only form: a signed-out call is withAuth's 401 on every handler, and
// the error paths this move touched answer fixed lines (the database's or
// Meta's own text is logged, never returned). The gates themselves are pinned
// by each route's own tests and tests/whatsapp-config-route-gates.test.js.
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/wa-template-access', () => ({ canManageWaTemplatesAt: vi.fn(() => true) }))
vi.mock('@/lib/whatsapp-template-submit', () => ({ submitWhatsappTemplate: vi.fn() }))

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { submitWhatsappTemplate } from '@/lib/whatsapp-template-submit'
import { createFakeDb } from '../../../../tests/helpers/fake-db.js'
import { LOC_A, MASTER } from '../../../../tests/helpers/owner-at-location-callers.js'
import * as broadcasts from './broadcasts/route.js'
import * as broadcast from './broadcasts/[id]/route.js'
import * as templates from './templates/route.js'
import * as convSend from './conversations/[id]/send/route.js'
import * as contactSend from '../contacts/[id]/whatsapp/route.js'
import * as studioNumbers from '../locations/[id]/whatsapp/numbers/route.js'

const ID = 'c0000000-0000-4000-8000-0000000000e1'
const TPL = 'c0000000-0000-4000-8000-0000000000f1'
const SECRET = 'raw provider text 555'
const json = (url, method, body) => new Request(`http://localhost${url}`, {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
})
const ctx = { params: Promise.resolve({ id: ID }) }
const noLeak = async (res, status, error) => {
  expect(res.status).toBe(status)
  const body = await res.json()
  expect(body.error).toBe(error)
  expect(JSON.stringify(body)).not.toContain(SECRET)
  expect(logError).toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MASTER)
})

describe('signed out: withAuth 401 on every handler, nothing read', () => {
  const cases = [
    ['GET broadcasts', broadcasts.GET],
    ['POST broadcasts', broadcasts.POST],
    ['GET broadcasts/[id]', broadcast.GET],
    ['PUT broadcasts/[id]', broadcast.PUT],
    ['DELETE broadcasts/[id]', broadcast.DELETE],
    ['GET templates', templates.GET],
    ['POST templates', templates.POST],
    ['POST conversations/[id]/send', convSend.POST],
    ['POST contacts/[id]/whatsapp', contactSend.POST],
    ['GET locations/[id]/whatsapp/numbers', studioNumbers.GET],
    ['PUT locations/[id]/whatsapp/numbers', studioNumbers.PUT],
  ]
  for (const [name, handler] of cases) {
    it(name, async () => {
      getCurrentUser.mockResolvedValue(null)
      const res = await handler(json('/api/whatsapp/x', 'POST', {}), ctx)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
      expect(createServerClient).not.toHaveBeenCalled()
    })
  }
})

describe('error text stays in the logs', () => {
  it('GET broadcasts: a failed list is a fixed 500', async () => {
    createServerClient.mockReturnValue(createFakeDb({ tables: { whatsapp_broadcasts: [] }, errors: { whatsapp_broadcasts: { select: { message: SECRET } } } }))
    await noLeak(await broadcasts.GET(json(`/api/whatsapp/broadcasts?location_id=${LOC_A}`, 'GET')), 500, 'Could not load the broadcasts')
  })

  it('POST broadcasts: a failed insert is a fixed 500', async () => {
    createServerClient.mockReturnValue(createFakeDb({
      tables: { whatsapp_templates: [{ id: TPL, location_id: LOC_A }], whatsapp_broadcasts: [] },
      errors: { whatsapp_broadcasts: { insert: { message: SECRET } } },
    }))
    const res = await broadcasts.POST(json('/api/whatsapp/broadcasts', 'POST', {
      name: 'B', template_id: TPL, location_id: LOC_A, audience_filter: { filters: [], logic: 'and' },
    }))
    await noLeak(res, 500, 'Could not save the broadcast')
  })

  it('GET broadcasts/[id]: a failed read is a plain 404', async () => {
    createServerClient.mockReturnValue(createFakeDb({ tables: { whatsapp_broadcasts: [] }, errors: { whatsapp_broadcasts: { select: { message: SECRET, code: '57014' } } } }))
    await noLeak(await broadcast.GET(json(`/api/whatsapp/broadcasts/${ID}`, 'GET'), ctx), 404, 'Broadcast not found')
  })

  it('GET broadcasts/[id]: no row is still 404 Broadcast not found, nothing logged', async () => {
    createServerClient.mockReturnValue(createFakeDb({ tables: { whatsapp_broadcasts: [] } }))
    const res = await broadcast.GET(json(`/api/whatsapp/broadcasts/${ID}`, 'GET'), ctx)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Broadcast not found')
    expect(logError).not.toHaveBeenCalled()
  })

  it('PUT broadcasts/[id]: a failed update is a fixed 500', async () => {
    createServerClient.mockReturnValue(createFakeDb({
      tables: {
        whatsapp_broadcasts: [{ id: ID, location_id: LOC_A, name: 'B', status: 'draft', signed_off_by: null }],
        locations: [{ id: LOC_A, name: 'Studio', settings: {} }],
      },
      errors: { whatsapp_broadcasts: { update: { message: SECRET } } },
    }))
    await noLeak(await broadcast.PUT(json(`/api/whatsapp/broadcasts/${ID}`, 'PUT', { name: 'New name' }), ctx), 500, 'Could not save the broadcast')
  })

  it('GET templates: a failed list is a fixed 500', async () => {
    createServerClient.mockReturnValue(createFakeDb({ tables: { whatsapp_templates: [] }, errors: { whatsapp_templates: { select: { message: SECRET } } } }))
    await noLeak(await templates.GET(json(`/api/whatsapp/templates?location_id=${LOC_A}`, 'GET')), 500, 'Could not load the templates')
  })

  it('POST templates: submitted to Meta but not saved here answers without the database text', async () => {
    createServerClient.mockReturnValue(createFakeDb({ tables: {} }))
    submitWhatsappTemplate.mockResolvedValue({
      ok: false, status: 400, code: 'orphan_at_meta',
      error: `The template was submitted to Meta but could not be saved here (${SECRET}). It exists at Meta; a re-sync will adopt it.`,
    })
    await noLeak(await templates.POST(json('/api/whatsapp/templates', 'POST', { name: 'promo_x', components: [], location_id: LOC_A })),
      400, 'The template was submitted to Meta but could not be saved here. It exists at Meta; a re-sync will adopt it.')
  })

  it('POST templates: any other refusal passes through as before', async () => {
    createServerClient.mockReturnValue(createFakeDb({ tables: {} }))
    submitWhatsappTemplate.mockResolvedValue({ ok: false, status: 409, error: 'No WhatsApp number is connected at this location.' })
    const res = await templates.POST(json('/api/whatsapp/templates', 'POST', { name: 'promo_x', components: [], location_id: LOC_A }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('No WhatsApp number is connected at this location.')
  })
})
