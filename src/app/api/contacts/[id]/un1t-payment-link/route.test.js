// STAFFPAYLINK.1 — staff sends a Hatch Street customer a un1t.online payment link.

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
vi.mock('@/lib/permissions', () => {
  const hasPermission = vi.fn(() => true)
  return {
    hasPermission,
    hasPermissionForLocation: (u, _l, k) => hasPermission(u, k),
    hasMobilePermissionForLocation: () => false,
  }
})
vi.mock('@/lib/un1t-payment-link-access', () => ({ canSendUn1tPaymentLink: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => dbMock) }))
vi.mock('@/lib/whatsapp-config', async () => ({
  pickTemplateConfig: (await vi.importActual('@/lib/whatsapp-config')).pickTemplateConfig,
}))
vi.mock('@/lib/whatsapp-own-number', () => ({ ownNumberOrRefusal: vi.fn(async () => ({ ok: true, config: { source: 'db', id: 'n1' } })) }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://hatch.example') }))
vi.mock('@/lib/contact-studios', () => ({ hasRelationshipAt: vi.fn(async () => ({ ok: true, at: new Set() })) }))
vi.mock('@/lib/agent/purchase-intents', () => ({
  listPurchaseOptions: vi.fn(async () => ({ offers: [{ offer_id: 'd0000000-0000-0000-0000-000000000009', title: '10 Class Pack', price_label: '€125', credits: 10, blurb: null }], skipped: 0 })),
}))
vi.mock('@/lib/staff-payment-links', async (orig) => ({
  ...(await orig()),
  issueStaffPaymentLink: vi.fn(),
  revokeStaffPaymentLink: vi.fn(async () => {}),
}))
vi.mock('@/lib/whatsapp', () => ({
  sendCtaUrlMessage: vi.fn(async () => ({ messageId: 'wamid.cta' })),
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.tpl' })),
  isWindowOpen: vi.fn(() => true),
  buildTemplateComponents: vi.fn(() => []),
  renderTemplateBody: vi.fn(() => 'Hi Aoife, your link.'),
  getOrCreateConversation: vi.fn(async () => 'conv-1'),
}))
vi.mock('@/lib/whatsapp-conversations', async (orig) => ({
  contactWaPhone: (await orig()).contactWaPhone,
  loadSendConversation: vi.fn(),
}))
vi.mock('@/lib/log', async (orig) => ({ ...(await orig()), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/agent/core', () => ({ manualTakeoverPatch: vi.fn(() => ({ agent_handed_off_at: 'x' })) }))

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { canSendUn1tPaymentLink } from '@/lib/un1t-payment-link-access'
import { issueStaffPaymentLink, revokeStaffPaymentLink } from '@/lib/staff-payment-links'
import { sendCtaUrlMessage, sendTemplateMessage, isWindowOpen, buildTemplateComponents, renderTemplateBody } from '@/lib/whatsapp'
import { logError } from '@/lib/log'
import { loadSendConversation } from '@/lib/whatsapp-conversations'
import { URL_BUTTON_MAPPING_KEY } from '@/lib/whatsapp-template-buttons'

const LOC = 'c0000000-0000-0000-0000-000000000003'
const OFFER = 'd0000000-0000-0000-0000-000000000009'
const USER = { id: 'u-1', role: 'manager', locations: [{ id: LOC }] }
let dbMock, contactRow, locationRow, templateRow, memberRow, writes, prefRow, adminPrefRow, messageInsertThrows, linkRow

function makeDb() {
  writes = []
  return {
    from: (table) => {
      const c = {
        select() { return c }, eq() { return c }, in() { return c }, order() { return c }, limit() { return c },
        insert(p) { if (table === 'whatsapp_messages' && messageInsertThrows) throw new Error('db down'); writes.push({ table, op: 'insert', payload: p }); return c },
        update(p) { writes.push({ table, op: 'update', payload: p }); return c },
        maybeSingle() {
          if (table === 'contacts') return Promise.resolve({ data: contactRow, error: null })
          if (table === 'locations') return Promise.resolve({ data: locationRow, error: null })
          if (table === 'contact_preferences') return Promise.resolve({ data: adminPrefRow, error: null })
          if (table === 'contact_location_preferences') return Promise.resolve({ data: prefRow, error: null })
          if (table === 'mia_purchase_offers') return Promise.resolve({ data: { id: OFFER, un1t_product_row_id: 'p-row' }, error: null })
          if (table === 'un1t_products') return Promise.resolve({ data: { id: 'p-row', un1t_id: 'un1t-p1', title: '10 Class Pack', type: 'pack', status: 'active', price_cents: 12500, currency: 'EUR' }, error: null })
          return Promise.resolve({ data: null, error: null })
        },
        then(res, rej) {
          let data = []
          if (table === 'whatsapp_templates') data = templateRow ? [templateRow] : []
          else if (table === 'whatsapp_conversations') data = [{ id: 'conv-1', window_expires_at: '2999-01-01T00:00:00Z' }]
          else if (table === 'contact_studios') data = memberRow ? [memberRow] : []
          else if (table === 'staff_payment_links') data = linkRow ? [linkRow] : []
          else if (table === 'mia_purchase_offers') data = [{ id: OFFER, un1t_product_row_id: 'p-row' }]
          else if (table === 'un1t_products') data = [{ id: 'p-row', type: 'recurring' }]
          return Promise.resolve({ data, error: null }).then(res, rej)
        },
      }
      return c
    },
  }
}

const goodTemplate = () => ({
  name: 'hatch_pay', language: 'en', category: 'UTILITY', status: 'APPROVED', business_account_id: 'w1',
  components: [{ type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay now', url: 'https://hatch.example/buy/{{1}}' }] }],
})

beforeEach(() => {
  vi.clearAllMocks()
  contactRow = { id: 'c-1', name: 'Aoife Byrne', first_name: 'Aoife', email: 'a@example.com', phone: '+353871234567', wa_phone: '353871234567', wa_status: 'active', location_id: LOC }
  locationRow = { id: LOC, name: 'UN1T Hatch Street', organization_id: 'org-1', membership_source: 'un1t_online', settings: { un1t_online: { writes_enabled: true, payment_link: { template_name: 'hatch_pay' } } } }
  templateRow = null
  memberRow = null
  prefRow = null
  adminPrefRow = null
  messageInsertThrows = false
  linkRow = null
  dbMock = makeDb()
  getCurrentUser.mockResolvedValue(USER)
  hasPermission.mockReturnValue(true)
  canSendUn1tPaymentLink.mockReturnValue(true)
  issueStaffPaymentLink.mockResolvedValue({ ok: true, linkId: 'l-1', token: 'TOKEN', expiresAt: '2026-11-22T00:00:00Z' })
  loadSendConversation.mockResolvedValue({ ok: true, conversation: { id: 'conv-1', window_expires_at: '2999-01-01', agent_handed_off_at: null } })
  isWindowOpen.mockReturnValue(true)
})

const params = { params: Promise.resolve({ id: 'c-1' }) }
const post = (body) => POST(new Request('http://x/api/contacts/c-1/un1t-payment-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), params)
const get = () => GET(new Request(`http://x/api/contacts/c-1/un1t-payment-link?locationId=${LOC}`), params)
const send = () => post({ locationId: LOC, offerId: OFFER })

describe('gates', () => {
  it('401 without a session, 404 at a studio the caller cannot see, 403 without the permission', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await send()).status).toBe(401)
    getCurrentUser.mockResolvedValue({ ...USER, locations: [{ id: 'other' }] })
    expect((await send()).status).toBe(404)
    getCurrentUser.mockResolvedValue(USER)
    canSendUn1tPaymentLink.mockReturnValue(false)
    expect((await send()).status).toBe(403)
    expect(issueStaffPaymentLink).not.toHaveBeenCalled()
  })

  it('404 for a contact who has no relationship with the studio', async () => {
    contactRow = { ...contactRow, location_id: 'elsewhere' }
    expect((await send()).status).toBe(404)
  })

  it('409 not_a_un1t_studio at a Glofox studio', async () => {
    locationRow = { ...locationRow, membership_source: 'glofox' }
    const res = await send()
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_a_un1t_studio')
  })

  it('400 with no email on file', async () => {
    contactRow = { ...contactRow, email: null }
    const res = await send()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Add an email to this contact first — un1t.online needs it for the account.')
  })

  it('409 when the person is WhatsApp-opted-out', async () => {
    contactRow = { ...contactRow, wa_status: 'opted_out' }
    expect((await send()).status).toBe(409)
    contactRow = { ...contactRow, wa_status: 'active' }
    prefRow = { whatsapp_marketing: false }
    expect((await send()).status).toBe(409)
    expect(issueStaffPaymentLink).not.toHaveBeenCalled()
  })

  it('409 needs_template when the window is closed and the template is MARKETING', async () => {
    isWindowOpen.mockReturnValue(false)
    templateRow = { ...goodTemplate(), category: 'MARKETING' }
    const res = await send()
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ needs_template: true })
    expect(issueStaffPaymentLink).not.toHaveBeenCalled()
  })
})

describe('POST send', () => {
  it('inside the window sends a cta button whose url is <base>/buy/<token>', async () => {
    const res = await send()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ linkId: 'l-1', via: 'cta' })
    expect(sendCtaUrlMessage.mock.calls[0][1].url).toBe('https://hatch.example/buy/TOKEN')
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(writes.find((w) => w.table === 'whatsapp_messages')).toBeTruthy()
    expect(writes.find((w) => w.table === 'activities').payload.type).toBe('un1t_payment_link_sent')
    expect(writes.find((w) => w.table === 'staff_payment_links').payload.whatsapp_message_id).toBe('wamid.cta')
  })

  it('outside the window sends the template with the first name, the product label and the token on the button', async () => {
    isWindowOpen.mockReturnValue(false)
    templateRow = goodTemplate()
    const res = await send()
    expect((await res.json()).data.via).toBe('template')
    expect(buildTemplateComponents.mock.calls[0][2]).toEqual({ '1': 'first_name', '2': '10 Class Pack, €125', [URL_BUTTON_MAPPING_KEY]: 'TOKEN' })
    expect(sendTemplateMessage).toHaveBeenCalledOnce()
  })

  it('a failed send revokes the link', async () => {
    sendCtaUrlMessage.mockRejectedValueOnce(new Error('Meta said no'))
    const res = await send()
    expect(res.status).toBe(502)
    expect(revokeStaffPaymentLink).toHaveBeenCalledWith(expect.anything(), 'l-1', 'Meta said no')
  })
})

describe('fix round 1', () => {
  it('409 when contact_preferences.whatsapp_administrative is false', async () => {
    adminPrefRow = { whatsapp_administrative: false }
    expect((await send()).status).toBe(409)
    expect(issueStaffPaymentLink).not.toHaveBeenCalled()
  })

  it('403 with the payment-link permission but no whatsapp permission', async () => {
    hasPermission.mockImplementation((u, k) => k !== 'whatsapp')
    expect((await send()).status).toBe(403)
    expect(issueStaffPaymentLink).not.toHaveBeenCalled()
  })

  it.each(['https://evil.example/buy/{{1}}', 'https://hatch.example/cancel/{{1}}'])('409 needs_template when the template button url is %s', async (url) => {
    isWindowOpen.mockReturnValue(false)
    const t = goodTemplate()
    t.components[0].buttons[0].url = url
    templateRow = t
    const res = await send()
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('needs_template')
  })

  it('a bookkeeping failure after a successful send keeps the link, and the other steps still run', async () => {
    messageInsertThrows = true
    const res = await send()
    expect(res.status).toBe(200)
    expect(revokeStaffPaymentLink).not.toHaveBeenCalled()
    const convWrite = writes.find((w) => w.table === 'whatsapp_conversations' && w.op === 'update')
    expect(convWrite.payload).toMatchObject({ handoff_requested_at: null })
    expect(Object.keys(convWrite.payload).filter((k) => k.startsWith('staff_'))).toEqual([])
    expect(writes.some((w) => w.table === 'staff_payment_links' && w.op === 'update')).toBe(true)
    expect(writes.some((w) => w.table === 'activities' && w.op === 'insert')).toBe(true)
  })

  it('a template body that fails to render is logged as [Template: <name>] and the bookkeeping still runs', async () => {
    isWindowOpen.mockReturnValue(false)
    templateRow = goodTemplate()
    renderTemplateBody.mockImplementationOnce(() => { throw new Error('bad template') })
    const res = await send()
    expect(res.status).toBe(200)
    const msg = writes.find((w) => w.table === 'whatsapp_messages')
    expect(msg.payload.body).toBe('[Template: hatch_pay]')
    expect(writes.some((w) => w.table === 'activities')).toBe(true)
  })

  it('a failed issue returns a fixed message and logs codes only, not the raw error', async () => {
    issueStaffPaymentLink.mockResolvedValueOnce({ ok: false, error: 'insert_failed', code: '23505' })
    const res = await send()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Could not create the payment link. Please try again.')
    const call = logError.mock.calls.find((c) => c[1] === 'link issue failed')
    expect(call[2]).toEqual({ contactId: 'c-1', locationId: LOC, reason: 'insert_failed', code: '23505' })
  })
})

describe('GET', () => {
  it('returns offers with the recurring flag, the first name and a live membership', async () => {
    memberRow = { membership_plan: 'Unlimited' }
    const res = await get()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.first_name).toBe('Aoife')
    expect(data.offers[0]).toEqual({ offer_id: OFFER, title: '10 Class Pack', price_label: '€125', recurring: true })
    expect(data.live_membership).toEqual({ plan: 'Unlimited' })
    expect(data.can).toMatchObject({ send: true, has_email: true, has_phone: true, window_open: true })
  })

  it('live_membership is null with no active membership', async () => {
    expect((await (await get()).json()).data.live_membership).toBeNull()
  })

  it('a live latest link past expires_at reads as expired; a live one in date keeps its status', async () => {
    linkRow = { status: 'opened', product_title: 'x', created_at: '2026-01-01T00:00:00Z', paid_at: null, expires_at: '2026-01-08T00:00:00Z', last_error: null }
    expect((await (await get()).json()).data.latest.status).toBe('expired')
    linkRow = { ...linkRow, expires_at: '2999-01-01T00:00:00Z' }
    expect((await (await get()).json()).data.latest.status).toBe('opened')
    linkRow = { ...linkRow, status: 'paid', expires_at: '2026-01-08T00:00:00Z' }
    expect((await (await get()).json()).data.latest.status).toBe('paid')
  })

  it('can.reason says why: writes off, WhatsApp opt-out, a free checkout; null when nothing is wrong', async () => {
    expect((await (await get()).json()).data.can.reason).toBeNull()
    locationRow.settings.un1t_online.writes_enabled = false
    let can = (await (await get()).json()).data.can
    expect(can.send).toBe(false)
    expect(can.reason).toBe('un1t.online is not switched on for this studio.')
    locationRow.settings.un1t_online.writes_enabled = true
    prefRow = { whatsapp_marketing: false }
    can = (await (await get()).json()).data.can
    expect(can.send).toBe(false)
    expect(can.reason).toBe('This customer has opted out of WhatsApp at this studio.')
    prefRow = null
    linkRow = { status: 'checkout_started', product_title: 'x', created_at: '2026-01-01T00:00:00Z', paid_at: null, expires_at: '2999-01-01T00:00:00Z', last_error: 'checkout_free' }
    can = (await (await get()).json()).data.can
    expect(can.reason).toBe('un1t.online says Aoife already has this product.')
  })
})

describe('GET preview_text', () => {
  const templateWithText = () => ({
    ...goodTemplate(),
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Payment request' },
      { type: 'BODY', text: 'Hi {{1}}, your UN1T Hatch Street order is ready for payment. Order: {{2}}. Use the button below to complete payment on un1t.online.' },
      ...goodTemplate().components,
    ],
  })

  it('outside the 24h window it previews the approved template the customer will receive', async () => {
    isWindowOpen.mockReturnValue(false)
    templateRow = templateWithText()
    const { data } = await (await get()).json()
    expect(data.can).toMatchObject({ window_open: false, template_ready: true })
    expect(data.preview_text).toBe('Payment request\nHi Aoife, your UN1T Hatch Street order is ready for payment. Order: {product}. Use the button below to complete payment on un1t.online.')
  })

  it('inside the window it previews the chat wording, not the template', async () => {
    templateRow = templateWithText()
    const { data } = await (await get()).json()
    expect(data.can.window_open).toBe(true)
    expect(data.preview_text).not.toContain('Payment request')
    expect(data.preview_text).toContain('Aoife')
    expect(data.preview_text).toContain('{product}')
  })
})
