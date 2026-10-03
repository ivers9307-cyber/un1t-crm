// WACONFIGFALLBACK.1 — every whatsapp.js helper that talks to Meta refuses,
// BEFORE any Meta call, when it cannot name the location's own number: a
// location with no active whatsapp_numbers row, or a call with neither
// `locationId` nor `config`. The global WHATSAPP_* env vars are SET here to
// prove they are ignored (they used to be the silent fallback). The real
// whatsapp-config resolver runs against a fake DB with no number rows.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const numberRows = { rows: [] }
vi.mock('./supabase', () => ({
  createServerClient: () => ({
    from: () => {
      const b = {}
      for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b
      b.then = (res, rej) => Promise.resolve({ data: numberRows.rows, error: null }).then(res, rej)
      return b
    },
  }),
}))

const wa = await import('./whatsapp.js')
const { isWhatsAppNumberMissing } = await import('./whatsapp-number-missing.js')

const ORIGINAL_ENV = { ...process.env }
const LOC = 'a0000000-0000-4000-8000-000000000001'
const ROW = {
  id: 'n1', location_id: LOC, label: 'Main', phone_number_id: 'PNI-SYNTH', business_account_id: 'WABA-SYNTH',
  app_id: 'APP-SYNTH', access_token: 'tok-synth', source: 'cloud_api', is_default: true, is_active: true,
}

// Each helper with the smallest valid arguments before its `opts`.
const CALLS = {
  sendTextMessage: (o) => wa.sendTextMessage('+353000000000', 'hi', o),
  sendInteractiveOptions: (o) => wa.sendInteractiveOptions('+353000000000', 'pick', ['a', 'b'], o),
  sendFlowMessage: (o) => wa.sendFlowMessage('+353000000000', { ...o, flowId: 'f1', flowToken: 't' }),
  sendCtaUrlMessage: (o) => wa.sendCtaUrlMessage('+353000000000', { bodyText: 'b', buttonText: 'Go', url: 'https://x.test' }, o),
  sendMediaCarousel: (o) => wa.sendMediaCarousel('+353000000000', { bodyText: 'b', cards: [{ image_url: 'https://x.test/a.jpg' }, { image_url: 'https://x.test/b.jpg' }] }, o),
  sendTemplateMessage: (o) => wa.sendTemplateMessage('+353000000000', 'tpl', 'en', [], o),
  sendMediaMessage: (o) => wa.sendMediaMessage('+353000000000', 'image', 'https://x.test/a.jpg', 'c', o),
  sendReaction: (o) => wa.sendReaction('+353000000000', 'wamid.1', '👍', o),
  markAsRead: (o) => wa.markAsRead('wamid.1', o),
  sendTypingIndicator: (o) => wa.sendTypingIndicator('wamid.1', o),
  setWhatsAppUserBlockState: (o) => wa.setWhatsAppUserBlockState('+353000000000', true, o),
  setConversationalAutomation: (o) => wa.setConversationalAutomation({ enableWelcome: true, prompts: [] }, o),
  uploadMediaForTemplate: (o) => wa.uploadMediaForTemplate(Buffer.from('x'), 'image/jpeg', o),
  createTemplate: (o) => wa.createTemplate({ name: 'n', components: [] }, o),
  getTemplates: (o) => wa.getTemplates(100, o),
  getTemplate: (o) => wa.getTemplate('n', o),
  deleteTemplate: (o) => wa.deleteTemplate('n', o),
  editTemplate: (o) => wa.editTemplate('meta-1', { components: [] }, o),
}

beforeEach(() => {
  numberRows.rows = []
  process.env.WHATSAPP_ACCESS_TOKEN = 'env-token'
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-pni'
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'env-waba'
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.OK' }], data: [], id: 'upload:1', h: 'h:1', success: true }) }))
})

afterAll(() => { process.env = { ...ORIGINAL_ENV } })

describe.each(Object.keys(CALLS))('%s', (name) => {
  it('a location with no number → typed refusal, Meta never called (the env number is ignored)', async () => {
    const err = await CALLS[name]({ locationId: LOC }).catch((e) => e)
    expect(isWhatsAppNumberMissing(err)).toBe(true)
    expect(err.locationId).toBe(LOC)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('no locationId and no config → typed refusal, Meta never called', async () => {
    const err = await CALLS[name]({}).catch((e) => e)
    expect(isWhatsAppNumberMissing(err)).toBe(true)
    expect(err.locationId).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it("the location's own number → Meta is called with that number's token", async () => {
    numberRows.rows = [ROW]
    await CALLS[name]({ locationId: LOC })
    expect(globalThis.fetch).toHaveBeenCalled()
    const [, init] = globalThis.fetch.mock.calls[0]
    expect(init.headers.Authorization).toMatch(/tok-synth$/)
  })
})
