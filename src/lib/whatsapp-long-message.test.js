// MIA-HYGIENE.6 — an over-long body used to be posted verbatim, so Meta
// rejected the send (4096-char cap on WhatsApp text) and sendTextMessage
// threw. To the customer that is dead air; staff learn about it from a
// debounced dead-air push later. Both senders now split at the channel limit.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./whatsapp-config', () => ({
  META_API_URL: 'https://graph.facebook.com/v21.0',
  getWhatsAppConfig: vi.fn(async () => ({ phoneNumberId: 'pn1', accessToken: 'tok' })),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
}))

import { sendTextMessage } from './whatsapp.js'
import { sendInstagramMessage } from './agent/instagram.js'
import { WHATSAPP_TEXT_LIMIT, INSTAGRAM_TEXT_LIMIT } from './message-split.js'

const bodies = () => fetch.mock.calls.map(([, opts]) => JSON.parse(opts.body))

describe('sendTextMessage — long bodies', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends a normal reply as exactly one message', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: 'wamid.1' }] }) }))
    await sendTextMessage('353870000000', 'Sure, what day suits?', { locationId: 'loc1' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(bodies()[0].text.body).toBe('Sure, what day suits?')
  })

  it('splits an over-long body into sequential sends, each within the cap', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: 'wamid.n' }] }) }))
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of a very long reply.`).join(' ')
    expect(long.length).toBeGreaterThan(WHATSAPP_TEXT_LIMIT)

    await sendTextMessage('353870000000', long, { locationId: 'loc1' })

    expect(fetch.mock.calls.length).toBeGreaterThan(1)
    for (const body of bodies()) {
      expect(body.text.body.length).toBeLessThanOrEqual(WHATSAPP_TEXT_LIMIT)
      expect(body.messaging_product).toBe('whatsapp')
    }
  })

  it('returns the LAST part id, so the caller logs the message the thread ends on', async () => {
    const ids = ['wamid.a', 'wamid.b', 'wamid.c']
    let i = 0
    global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: ids[i++] }] }) }))
    const long = 'z'.repeat(WHATSAPP_TEXT_LIMIT * 2 + 10)

    const out = await sendTextMessage('353870000000', long, { locationId: 'loc1' })

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(out.messageId).toBe('wamid.c')
  })

  it('still throws on a Meta error so the dead-air path can fire', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ error: { message: 'Invalid recipient' } }) }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(sendTextMessage('353870000000', 'hi', { locationId: 'loc1' })).rejects.toThrow('Invalid recipient')
  })
})

describe('sendInstagramMessage — long bodies', () => {
  afterEach(() => vi.restoreAllMocks())

  const connection = { access_token: 'tok', external_account_id: 'ig1' }

  it('sends a normal DM as exactly one message', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ message_id: 'ig.1' }) }))
    await sendInstagramMessage('igsid-1', 'Sure, what day suits?', { connection })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('splits past the Instagram cap, which is far lower than WhatsApp', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ message_id: 'ig.n' }) }))
    const long = 'y'.repeat(INSTAGRAM_TEXT_LIMIT * 2 + 10)

    await sendInstagramMessage('igsid-1', long, { connection })

    expect(fetch).toHaveBeenCalledTimes(3)
    for (const [, opts] of fetch.mock.calls) {
      expect(JSON.parse(opts.body).message.text.length).toBeLessThanOrEqual(INSTAGRAM_TEXT_LIMIT)
    }
  })
})
