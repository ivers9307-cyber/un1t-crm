import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the WhatsApp send layer so the unit test never touches Meta or env.
vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.TEST', status: 'sent' })),
  buildTemplateComponents: vi.fn(() => [{ type: 'body', parameters: [{ type: 'text', text: 'Sarah' }] }]),
  renderTemplateBody: vi.fn(() => 'Hi Sarah!'),
  getOrCreateConversation: vi.fn(async () => 'conv-1'),
}))

import { maybeSendCampaignWhatsappWelcome } from './meta-ad-whatsapp-welcome'
import { sendTemplateMessage } from '@/lib/whatsapp'

// Minimal supabase-js-ish builder mock — only the chains this code uses.
function makeDb(template) {
  return {
    from(tbl) {
      if (tbl === 'whatsapp_templates') {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: template }) }) }) }) }
      }
      if (tbl === 'contacts') {
        return { update: () => ({ eq: () => ({ is: async () => ({}) }) }) }
      }
      if (tbl === 'whatsapp_messages') {
        return { insert: async () => ({}) }
      }
      return {}
    },
  }
}

const APPROVED = {
  name: 'meta_ad_whatsapp_lead', status: 'APPROVED', language: 'en',
  header_media_url: 'https://x/v.mp4', components: [{ type: 'BODY', text: 'Hi {{1}}!' }],
}

beforeEach(() => vi.clearAllMocks())

describe('maybeSendCampaignWhatsappWelcome — guards (never throws, never sends)', () => {
  it('no template configured', async () => {
    const r = await maybeSendCampaignWhatsappWelcome({ db: makeDb(null), locationId: 'L', contact: { phone: '0871234567' }, templateName: null })
    expect(r).toEqual({ sent: false, reason: 'no_template_configured' })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
  it('contact has no phone', async () => {
    const r = await maybeSendCampaignWhatsappWelcome({ db: makeDb(null), locationId: 'L', contact: {}, templateName: 'meta_ad_whatsapp_lead' })
    expect(r).toEqual({ sent: false, reason: 'no_phone' })
  })
  it('phone cannot be normalised to E.164', async () => {
    const r = await maybeSendCampaignWhatsappWelcome({ db: makeDb(null), locationId: 'L', contact: { phone: '12' }, templateName: 'meta_ad_whatsapp_lead' })
    expect(r).toEqual({ sent: false, reason: 'unnormalisable_phone' })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
  it('template not found at this location', async () => {
    const r = await maybeSendCampaignWhatsappWelcome({ db: makeDb(null), locationId: 'L', contact: { phone: '0871234567' }, templateName: 'meta_ad_whatsapp_lead' })
    expect(r).toEqual({ sent: false, reason: 'template_not_found' })
  })
  it('template not yet APPROVED', async () => {
    const r = await maybeSendCampaignWhatsappWelcome({ db: makeDb({ ...APPROVED, status: 'PENDING' }), locationId: 'L', contact: { phone: '0871234567' }, templateName: 'meta_ad_whatsapp_lead' })
    expect(r).toEqual({ sent: false, reason: 'template_PENDING' })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
})

describe('maybeSendCampaignWhatsappWelcome — happy path', () => {
  it('sends the template to the E.164 phone and reports the message id', async () => {
    const r = await maybeSendCampaignWhatsappWelcome({
      db: makeDb(APPROVED), locationId: 'a0000000-0000-0000-0000-000000000001',
      contact: { id: 'c1', first_name: 'Sarah', phone: '0871234567', wa_phone: null }, templateName: 'meta_ad_whatsapp_lead',
    })
    expect(r).toEqual({ sent: true, messageId: 'wamid.TEST' })
    // Irish local 087… is normalised to +353…
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      '+353871234567', 'meta_ad_whatsapp_lead', 'en', expect.any(Array), { locationId: 'a0000000-0000-0000-0000-000000000001' },
    )
  })
})

describe('maybeSendCampaignWhatsappWelcome — Flow toggle', () => {
  function makeFlowDb(template, settings) {
    return {
      from(tbl) {
        if (tbl === 'locations') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings } }) }) }) }
        if (tbl === 'whatsapp_templates') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: template }) }) }) }) }
        if (tbl === 'contacts') return { update: () => ({ eq: () => ({ is: async () => ({}) }) }) }
        if (tbl === 'whatsapp_messages') return { insert: async () => ({}) }
        return {}
      },
    }
  }
  const FLOW_TPL = { name: 'book_first_visit', status: 'APPROVED', language: 'en', header_media_url: null, components: [{ type: 'BODY', text: 'Hi {{1}}!' }] }

  it('when whatsapp_flow.enabled → sends the FLOW template with a flow_token button', async () => {
    const r = await maybeSendCampaignWhatsappWelcome({
      db: makeFlowDb(FLOW_TPL, { whatsapp_flow: { enabled: true, template_name: 'book_first_visit' } }),
      locationId: 'loc1', contact: { id: 'c1', first_name: 'Sarah', phone: '0871234567', wa_phone: null }, templateName: 'meta_ad_whatsapp_lead',
    })
    expect(r).toEqual({ sent: true, messageId: 'wamid.TEST' })
    const [, tplName, , components] = sendTemplateMessage.mock.calls[0]
    expect(tplName).toBe('book_first_visit')
    const flowBtn = components.find((c) => c.sub_type === 'flow')
    expect(flowBtn.parameters[0].action.flow_token).toBe('c1.loc1')
    // Meta requires the button index as a STRING '0' (a numeric 0 is rejected 131009).
    expect(flowBtn.index).toBe('0')
  })

  it('when disabled → keeps the passed template, no flow button', async () => {
    const r = await maybeSendCampaignWhatsappWelcome({
      db: makeFlowDb(APPROVED, { whatsapp_flow: { enabled: false } }),
      locationId: 'loc1', contact: { id: 'c1', first_name: 'Sarah', phone: '0871234567', wa_phone: null }, templateName: 'meta_ad_whatsapp_lead',
    })
    expect(r.sent).toBe(true)
    const [, tplName, , components] = sendTemplateMessage.mock.calls[0]
    expect(tplName).toBe('meta_ad_whatsapp_lead')
    expect(components.find((c) => c.sub_type === 'flow')).toBeUndefined()
  })
})
