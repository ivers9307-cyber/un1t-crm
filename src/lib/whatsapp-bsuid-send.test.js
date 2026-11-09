// WA-BSUID.2 — every Cloud API send addresses a business-scoped user id with
// Meta's `recipient` field, and a phone number with `to`, exactly as before.
// One assertion per send function: a send that still put a BSUID in `to`
// would be refused by Meta, and the person (who hides their number) could
// then never be answered.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./whatsapp-config', () => ({
  META_API_URL: 'https://graph.facebook.com/v21.0',
  getWhatsAppConfig: vi.fn(async () => ({ phoneNumberId: 'pn1', accessToken: 'tok' })),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
}))

import {
  sendTextMessage, sendTemplateMessage, sendMediaMessage, sendReaction, sendInteractiveOptions,
  buildFlowPayload, buildCtaUrlPayload, buildMediaCarouselPayload,
} from './whatsapp.js'

const BSUID = 'IE.13491208655302741918'
const PHONE = '353870000001'
const sentBody = () => JSON.parse(fetch.mock.calls[0][1].body)

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: 'wamid.out' }] }) }))
})
afterEach(() => vi.restoreAllMocks())

const SENDS = {
  text: (to) => sendTextMessage(to, 'hello', { locationId: 'loc1' }),
  template: (to) => sendTemplateMessage(to, 'welcome', 'en', [], { locationId: 'loc1' }),
  media: (to) => sendMediaMessage(to, 'image', 'https://x.test/a.jpg', 'caption', { locationId: 'loc1' }),
  reaction: (to) => sendReaction(to, 'wamid.target', '👍', { locationId: 'loc1' }),
  options: (to) => sendInteractiveOptions(to, 'Pick one', ['A', 'B'], { locationId: 'loc1' }),
}

describe('sends to a business-scoped user id', () => {
  for (const [name, send] of Object.entries(SENDS)) {
    it(`${name}: recipient, never to`, async () => {
      await send(BSUID)
      const body = sentBody()
      expect(body.recipient).toBe(BSUID)
      expect('to' in body).toBe(false)
      expect(body.recipient_type).toBe('individual')
    })

    it(`${name}: a phone number is still sent as to`, async () => {
      await send(PHONE)
      const body = sentBody()
      expect(body.to).toBe(PHONE)
      expect('recipient' in body).toBe(false)
    })
  }

  it('the interactive payload builders address the same way', () => {
    const flow = buildFlowPayload(BSUID, { flowId: 'f1', flowToken: 't', flowCta: 'Book', screen: 'DAY', bodyText: 'Book a class' })
    const cta = buildCtaUrlPayload(BSUID, { bodyText: 'See it', buttonText: 'Open', url: 'https://x.test' })
    const carousel = buildMediaCarouselPayload(BSUID, { bodyText: 'Look', cards: [{ image_url: 'https://x.test/1.jpg', title: 'One' }, { image_url: 'https://x.test/2.jpg', title: 'Two' }] })
    for (const payload of [flow, cta, carousel]) {
      expect(payload.recipient).toBe(BSUID)
      expect('to' in payload).toBe(false)
    }
    expect(buildFlowPayload(PHONE, { flowId: 'f1', flowToken: 't', flowCta: 'Book', screen: 'DAY', bodyText: 'Book a class' }).to).toBe(PHONE)
  })
})
