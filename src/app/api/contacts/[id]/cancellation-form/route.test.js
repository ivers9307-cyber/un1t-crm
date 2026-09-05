// CANCEL-FORM.4 — staff sends a member the cancellation form link.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    return null
  },
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true), hasMobilePermission: vi.fn(() => false) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => dbMock) }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.example' }))
vi.mock('@/lib/cancellation-form/links', () => ({
  issueLink: vi.fn(), revokeLink: vi.fn(), latestLinkForContact: vi.fn(async () => null),
}))
vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: vi.fn(async () => ({ messageId: 'pm-1' })) }))
vi.mock('@/lib/whatsapp', () => ({
  sendCtaUrlMessage: vi.fn(async () => ({ messageId: 'wamid.cta' })),
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.tpl' })),
  isWindowOpen: vi.fn(() => true),
  buildTemplateComponents: vi.fn(() => [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'TOKEN' }] }]),
  renderTemplateBody: vi.fn(() => 'Hi Aoife, here is the link.'),
}))
vi.mock('@/lib/whatsapp-conversations', () => ({ getOrCreateContactConversation: vi.fn() }))
vi.mock('@/lib/agent/core', () => ({
  manualTakeoverPatch: vi.fn(() => ({ agent_handed_off_at: 'x' })),
  stripEmDashes: (t) => String(t ?? '').replace(/\s*[—–]\s+/g, ', ').replace(/[—–]/g, '-'),
}))

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { issueLink, revokeLink, latestLinkForContact } from '@/lib/cancellation-form/links'
import { sendTransactionalEmail } from '@/lib/postmark'
import { sendCtaUrlMessage, sendTemplateMessage, isWindowOpen, buildTemplateComponents } from '@/lib/whatsapp'
import { getOrCreateContactConversation } from '@/lib/whatsapp-conversations'

const LOC = 'c0000000-0000-0000-0000-000000000003'
const USER = { id: 'u-1', role: 'manager', locations: [{ id: LOC }] }
let dbMock, contactRow, templateRow, writes

function makeDb() {
  writes = []
  return {
    from: (table) => {
      const st = { op: 'select', payload: null }
      const c = {
        select() { return c }, eq() { return c }, order() { return c }, limit() { return c }, is() { return c },
        insert(p) { st.op = 'insert'; st.payload = p; writes.push({ table, op: 'insert', payload: p }); return c },
        update(p) { st.op = 'update'; st.payload = p; writes.push({ table, op: 'update', payload: p }); return c },
        single() {
          if (table === 'contacts') return Promise.resolve(contactRow ? { data: contactRow, error: null } : { data: null, error: { message: 'none' } })
          return Promise.resolve({ data: { id: 'x' }, error: null })
        },
        maybeSingle() {
          if (table === 'locations') return Promise.resolve({ data: { name: 'UN1T Stillorgan', settings: { customer_agent: { cancellation_form: { whatsapp_template_name: templateRow ? templateRow.name : null } } } }, error: null })
          return Promise.resolve({ data: null, error: null })
        },
        then(res, rej) {
          const data = table === 'whatsapp_templates' ? (templateRow ? [templateRow] : [])
            : table === 'whatsapp_conversations' ? [{ id: 'conv-1', window_expires_at: '2999-01-01T00:00:00Z' }] : []
          return Promise.resolve({ data, error: null }).then(res, rej)
        },
      }
      return c
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  contactRow = { id: 'c-1', name: 'Aoife Byrne', first_name: 'Aoife', email: 'a@example.com', email_status: 'active', phone: '+353871234567', wa_phone: '+353871234567', location_id: LOC, glofox_membership_plan: 'Unlimited' }
  templateRow = null
  dbMock = makeDb()
  getCurrentUser.mockResolvedValue(USER)
  hasPermission.mockReturnValue(true)
  issueLink.mockResolvedValue({ ok: true, linkId: 'l-1', token: 'TOKEN', url: 'https://crm.example/cancel/TOKEN', expiresAt: '2026-10-05T00:00:00Z' })
  getOrCreateContactConversation.mockResolvedValue({ ok: true, conversation: { id: 'conv-1', window_expires_at: '2999-01-01', agent_handed_off_at: null }, waPhone: '353871234567' })
  isWindowOpen.mockReturnValue(true)
})

const params = { params: Promise.resolve({ id: 'c-1' }) }
const post = (body) => POST(new Request('http://x/api/contacts/c-1/cancellation-form', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), params)
const get = () => GET(new Request('http://x/api/contacts/c-1/cancellation-form'), params)

describe('auth + IDOR', () => {
  it('401 without a session, 404 for a contact outside the caller locations, 403 without the channel permission', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ channel: 'email' })).status).toBe(401)
    getCurrentUser.mockResolvedValue({ ...USER, locations: [{ id: 'other' }] })
    expect((await post({ channel: 'email' })).status).toBe(404)
    getCurrentUser.mockResolvedValue(USER)
    hasPermission.mockReturnValue(false)
    expect((await post({ channel: 'email' })).status).toBe(403)
    expect(issueLink).not.toHaveBeenCalled()
  })
})

describe('GET', () => {
  it('reports capabilities, the latest link and a rendered preview without a link placeholder', async () => {
    latestLinkForContact.mockResolvedValueOnce({ id: 'l-0', issued_at: '2026-09-01T00:00:00Z', channel: 'email', opened_at: null, used_at: null, revoked_at: null, expires_at: '2026-10-01T00:00:00Z', request_id: null })
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.can).toMatchObject({ email: true, whatsapp: true, whatsapp_window_open: true, whatsapp_template_ready: false })
    expect(body.data.latest.id).toBe('l-0')
    expect(body.data.preview.email_subject).toBe('Your membership with UN1T Stillorgan')
    expect(body.data.preview.email_body).toContain('{link}')
    expect(body.data.preview.whatsapp_text).toContain('Aoife')
  })
})

describe('POST email', () => {
  it('sends a transactional email with the link (no marketing-consent gate) and logs the activity', async () => {
    const res = await post({ channel: 'email' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ linkId: 'l-1', channel: 'email' })
    expect(issueLink).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactId: 'c-1', locationId: LOC, issuedBy: 'u-1', channel: 'email', baseUrl: 'https://crm.example' }))
    const call = sendTransactionalEmail.mock.calls[0][0]
    expect(call).toMatchObject({ to: 'a@example.com', contactId: 'c-1', locationId: LOC, tag: 'cancellation_form' })
    expect(call.htmlBody).toContain('https://crm.example/cancel/TOKEN')
    expect(writes.find((w) => w.table === 'activities').payload).toMatchObject({ type: 'cancellation_form_sent', contact_id: 'c-1', created_by: 'u-1' })
    // Marketing consent is never consulted: a cancellation form is a service
    // message the member asked for.
    expect(writes.some((w) => w.table === 'contact_location_preferences')).toBe(false)
  })

  it('refuses when the address has bounced or complained, or is missing — before minting a link', async () => {
    contactRow.email_status = 'bounced'
    expect((await post({ channel: 'email' })).status).toBe(400)
    contactRow.email_status = 'active'; contactRow.email = null
    expect((await post({ channel: 'email' })).status).toBe(400)
    expect(issueLink).not.toHaveBeenCalled()
  })

  it('revokes the link and 502s when Postmark fails', async () => {
    sendTransactionalEmail.mockRejectedValueOnce(new Error('postmark 422'))
    const res = await post({ channel: 'email' })
    expect(res.status).toBe(502)
    expect(revokeLink).toHaveBeenCalledWith(expect.anything(), 'l-1', expect.stringMatching(/postmark 422/))
  })

  it('honours a one-off message override, still carrying the link', async () => {
    await post({ channel: 'email', message: 'Hi {first_name}, as discussed.' })
    const call = sendTransactionalEmail.mock.calls[0][0]
    expect(call.htmlBody).toContain('Hi Aoife, as discussed.')
    expect(call.htmlBody).toContain('https://crm.example/cancel/TOKEN')
  })
})

describe('POST whatsapp', () => {
  it('inside the 24h window sends a cta_url button, logs the message, applies manual takeover and passes conversation_id to the link', async () => {
    const res = await post({ channel: 'whatsapp' })
    expect(res.status).toBe(200)
    expect(issueLink).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ channel: 'whatsapp', conversationId: 'conv-1' }))
    expect(sendCtaUrlMessage).toHaveBeenCalledWith('353871234567', expect.objectContaining({ buttonText: 'Open form', url: 'https://crm.example/cancel/TOKEN' }), { locationId: LOC })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    const msg = writes.find((w) => w.table === 'whatsapp_messages').payload
    expect(msg).toMatchObject({ conversation_id: 'conv-1', direction: 'outbound', message_type: 'interactive', sent_by: 'u-1', wa_message_id: 'wamid.cta' })
    const conv = writes.find((w) => w.table === 'whatsapp_conversations' && w.op === 'update').payload
    expect(conv).toMatchObject({ last_message_direction: 'outbound', agent_handed_off_at: 'x' })
  })

  it('outside the window with no template configured → 409 naming the fix, no link minted', async () => {
    isWindowOpen.mockReturnValue(false)
    const res = await post({ channel: 'whatsapp' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, window_expired: true, needs_template: true })
    expect(issueLink).not.toHaveBeenCalled()
  })

  it('outside the window sends the approved template with the token on the URL button', async () => {
    isWindowOpen.mockReturnValue(false)
    templateRow = {
      name: 'cancellation_form_link', language: 'en', status: 'APPROVED', category: 'UTILITY', header_media_url: null,
      components: [
        { type: 'BODY', text: 'Hi {{1}}, here is the link to pause or cancel your membership.' },
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open form', url: 'https://crm.example/cancel/{{1}}' }] },
      ],
    }
    const res = await post({ channel: 'whatsapp' })
    expect(res.status).toBe(200)
    expect(buildTemplateComponents).toHaveBeenCalledWith(templateRow, expect.objectContaining({ id: 'c-1' }), { url_button: 'TOKEN' }, null, expect.objectContaining({ locationId: LOC }))
    expect(sendTemplateMessage).toHaveBeenCalledWith('353871234567', 'cancellation_form_link', 'en', expect.any(Array), { locationId: LOC })
    const msg = writes.find((w) => w.table === 'whatsapp_messages').payload
    expect(msg).toMatchObject({ message_type: 'template', template_name: 'cancellation_form_link', body: 'Hi Aoife, here is the link.' })
  })

  it('refuses a template whose URL button is rooted on another host', async () => {
    isWindowOpen.mockReturnValue(false)
    templateRow = {
      name: 'cancellation_form_link', language: 'en', status: 'APPROVED', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Hi {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open', url: 'https://other.example/cancel/{{1}}' }] }],
    }
    const res = await post({ channel: 'whatsapp' })
    expect(res.status).toBe(409)
    expect((await res.json()).needs_template).toBe(true)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(issueLink).not.toHaveBeenCalled()
  })

  it('400s without a phone number', async () => {
    contactRow.phone = null; contactRow.wa_phone = null
    expect((await post({ channel: 'whatsapp' })).status).toBe(400)
  })

  it('revokes the link and 502s when Meta rejects the send', async () => {
    sendCtaUrlMessage.mockRejectedValueOnce(new Error('meta 131'))
    const res = await post({ channel: 'whatsapp' })
    expect(res.status).toBe(502)
    expect(revokeLink).toHaveBeenCalledWith(expect.anything(), 'l-1', expect.stringMatching(/meta 131/))
  })
})
