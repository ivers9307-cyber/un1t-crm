// ROUTEWRAP.R9 — the WhatsApp broadcast, template and conversation routes
// moved onto withAuth: a signed-out call is withAuth's 401 on every handler,
// and the error paths this move touched answer fixed lines (the database's
// or Meta's own text is logged, never returned). The gates themselves are
// pinned by each route's own tests and tests/whatsapp-config-route-gates.test.js.
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/wa-template-access', () => ({ canManageWaTemplatesAt: vi.fn(() => true), canUploadWaTemplateMediaAt: vi.fn(() => true) }))
vi.mock('@/lib/whatsapp-own-number', () => ({
  templateNumberOrRefusal: vi.fn(async () => ({ ok: true, config: { id: 'n1' } })),
  ownNumberOrRefusal: vi.fn(async () => ({ ok: true, config: { id: 'n1' } })),
}))
vi.mock('@/lib/whatsapp', async (importOriginal) => ({
  ...(await importOriginal()),
  editTemplate: vi.fn(),
  uploadMediaForTemplate: vi.fn(),
  sendBroadcast: vi.fn(),
  deleteTemplate: vi.fn(),
}))
vi.mock('@/lib/inbox-assignment', () => ({ attachAssigneeNames: vi.fn() }))

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { editTemplate, uploadMediaForTemplate, sendBroadcast } from '@/lib/whatsapp'
import { createFakeDb } from '../../../../tests/helpers/fake-db.js'
import { LOC_A, MASTER, person } from '../../../../tests/helpers/owner-at-location-callers.js'
import * as pause from './broadcasts/[id]/pause/route.js'
import * as send from './broadcasts/[id]/send/route.js'
import * as signOff from './broadcasts/[id]/sign-off/route.js'
import * as sign from './templates/upload-media/sign/route.js'
import * as uploadMedia from './templates/upload-media/route.js'
import * as resubmit from './templates/[id]/resubmit/route.js'
import * as template from './templates/[id]/route.js'
import * as conversations from './conversations/route.js'
import * as start from './conversations/start/route.js'

const ID = 'c0000000-0000-4000-8000-0000000000e1'
const CONTACT = 'c0000000-0000-4000-8000-0000000000c1'
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
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'owner' }, LOC_A))
})

describe('signed out: withAuth 401 on every handler, nothing read', () => {
  const cases = [
    ['POST broadcasts/[id]/pause', pause.POST],
    ['POST broadcasts/[id]/send', send.POST],
    ['POST broadcasts/[id]/sign-off', signOff.POST],
    ['POST templates/upload-media/sign', sign.POST],
    ['POST templates/upload-media', uploadMedia.POST],
    ['POST templates/[id]/resubmit', resubmit.POST],
    ['GET templates/[id]', template.GET],
    ['PUT templates/[id]', template.PUT],
    ['DELETE templates/[id]', template.DELETE],
    ['GET conversations', conversations.GET],
    ['POST conversations/start', start.POST],
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
  it('GET templates/[id]: a failed read is a plain 404', async () => {
    createServerClient.mockReturnValue(createFakeDb({ tables: { whatsapp_templates: [] }, errors: { whatsapp_templates: { select: { message: SECRET, code: '57014' } } } }))
    await noLeak(await template.GET(json(`/api/whatsapp/templates/${ID}`, 'GET'), ctx), 404, 'Template not found')
  })

  it('GET templates/[id]: no row is still 404 Template not found', async () => {
    createServerClient.mockReturnValue(createFakeDb({ tables: { whatsapp_templates: [] } }))
    const res = await template.GET(json(`/api/whatsapp/templates/${ID}`, 'GET'), ctx)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Template not found')
  })

  it('PUT and DELETE templates/[id]: a failed write is a fixed 500', async () => {
    const seed = () => createFakeDb({
      tables: { whatsapp_templates: [{ id: ID, location_id: LOC_A, name: 'tpl', status: 'DRAFT', business_account_id: null }] },
      errors: { whatsapp_templates: { update: { message: SECRET }, delete: { message: SECRET } } },
    })
    createServerClient.mockReturnValue(seed())
    await noLeak(await template.PUT(json(`/api/whatsapp/templates/${ID}`, 'PUT', { display_group: 'A' }), ctx), 500, 'Could not save the template. Try again.')
    createServerClient.mockReturnValue(seed())
    await noLeak(await template.DELETE(json(`/api/whatsapp/templates/${ID}`, 'DELETE'), ctx), 500, 'Could not delete the template. Try again.')
  })

  it("POST templates/[id]/resubmit: Meta's refusal is a fixed 400", async () => {
    createServerClient.mockReturnValue(createFakeDb({ tables: { whatsapp_templates: [{ id: ID, location_id: LOC_A, name: 'tpl', status: 'REJECTED', meta_template_id: 'm1' }] } }))
    editTemplate.mockRejectedValue(new Error(SECRET))
    await noLeak(await resubmit.POST(json(`/api/whatsapp/templates/${ID}/resubmit`, 'POST', { components: [{ type: 'BODY', text: 'Hi' }] }), ctx),
      400, 'Could not resubmit the template. Check it and try again.')
  })

  it("POST templates/upload-media: Meta's upload error is a fixed meta_error", async () => {
    const path = `${LOC_A}/0b6f1a7e-2b7c-4c1e-9b1a-1a2b3c4d5e6f.png`
    createServerClient.mockReturnValue({
      storage: {
        from: () => ({
          download: async () => ({ data: new Blob([new Uint8Array(100)]), error: null }),
          getPublicUrl: () => ({ data: { publicUrl: 'https://example.test/x.png' } }),
          remove: () => Promise.resolve({}),
        }),
      },
    })
    uploadMediaForTemplate.mockRejectedValue(new Error(SECRET))
    const res = await uploadMedia.POST(json('/api/whatsapp/templates/upload-media', 'POST', { path, format: 'IMAGE', mime: 'image/png', file_name: 'x.png' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.handle).toBeNull()
    expect(body.meta_error).toBe('Meta did not accept the upload. Try again.')
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })

  it('POST templates/upload-media: a missing object is a fixed 404', async () => {
    const path = `${LOC_A}/0b6f1a7e-2b7c-4c1e-9b1a-1a2b3c4d5e6f.png`
    createServerClient.mockReturnValue({ storage: { from: () => ({ download: async () => ({ data: null, error: { message: SECRET } }) }) } })
    await noLeak(await uploadMedia.POST(json('/api/whatsapp/templates/upload-media', 'POST', { path, format: 'IMAGE', mime: 'image/png', file_name: 'x.png' })),
      404, 'Uploaded file not found in storage — try the upload again.')
  })

  it('GET conversations: a failed list is a fixed 500', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    createServerClient.mockReturnValue(createFakeDb({ tables: { whatsapp_conversations: [] }, errors: { whatsapp_conversations: { select: { message: SECRET } } } }))
    await noLeak(await conversations.GET(json(`/api/whatsapp/conversations?location_id=${LOC_A}`, 'GET')), 500, 'Could not load conversations. Try again.')
  })

  it('POST conversations/start: a failed insert with no row to fall back on is a fixed 500', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    createServerClient.mockReturnValue(createFakeDb({
      tables: { contacts: [{ id: CONTACT, location_id: LOC_A, phone: '+353871234567', wa_phone: '353871234567' }], whatsapp_conversations: [] },
      errors: { whatsapp_conversations: { insert: { message: SECRET } } },
    }))
    await noLeak(await start.POST(json('/api/whatsapp/conversations/start', 'POST', { contact_id: CONTACT })), 500, 'Could not start the conversation. Try again.')
  })

  it("POST broadcasts/[id]/send: a failed status flip's database text is replaced; engine copy passes", async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const db = () => createFakeDb({ tables: { whatsapp_broadcasts: [{ id: ID, location_id: LOC_A, name: 'B', signed_off_by: null }], locations: [{ id: LOC_A, name: 'Studio', settings: {} }] } })
    createServerClient.mockReturnValue(db())
    sendBroadcast.mockRejectedValue(new Error(`Could not start the broadcast: ${SECRET}`))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let res = await send.POST(json(`/api/whatsapp/broadcasts/${ID}/send`, 'POST', {}), ctx)
    expect(res.status).toBe(400)
    let body = await res.json()
    expect(body.error).toBe('Could not start the broadcast. Try again.')
    expect(JSON.stringify(body)).not.toContain(SECRET)
    createServerClient.mockReturnValue(db())
    sendBroadcast.mockRejectedValue(new Error('Template not approved by Meta'))
    res = await send.POST(json(`/api/whatsapp/broadcasts/${ID}/send`, 'POST', {}), ctx)
    expect((await res.json()).error).toBe('Template not approved by Meta')
  })
})
