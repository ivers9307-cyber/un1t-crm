import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./whatsapp-config', () => ({
  META_API_URL: 'https://graph.facebook.com/v21.0',
  getWhatsAppConfig: vi.fn(async () => ({ phoneNumberId: 'pn1', accessToken: 'tok' })),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
}))

import { sendTypingIndicator } from './whatsapp.js'
import { whatsappAdapter } from './agent/auto-reply.js'

describe('sendTypingIndicator', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends read + typing_indicator in one Meta call', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({}) }))
    await sendTypingIndicator('wamid.ABC', { locationId: 'loc1' })
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v21.0/pn1/messages')
    expect(JSON.parse(opts.body)).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.ABC',
      typing_indicator: { type: 'text' },
    })
  })
})

describe('whatsappAdapter.onEngage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('fires the typing indicator with the inbound wamid', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({}) }))
    await whatsappAdapter.onEngage({ waMessageId: 'wamid.X', locationId: 'loc1' })
    expect(JSON.parse(fetch.mock.calls[0][1].body).message_id).toBe('wamid.X')
  })

  it('no wamid → no call; a Meta failure never throws', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network down') })
    await whatsappAdapter.onEngage({ waMessageId: null, locationId: 'loc1' })
    expect(fetch).not.toHaveBeenCalled()
    await expect(whatsappAdapter.onEngage({ waMessageId: 'wamid.Y', locationId: 'loc1' })).resolves.toBeUndefined()
  })
})
