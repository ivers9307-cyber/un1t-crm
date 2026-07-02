import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock the config module BEFORE importing whatsapp.js so resolveConfig
// resolves a deterministic phone number + token without env/db.
vi.mock('./whatsapp-config', () => ({
  META_API_URL: 'https://graph.facebook.com/v21.0',
  getWhatsAppConfig: vi.fn(async () => ({ phoneNumberId: 'pn1', accessToken: 'tok' })),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
}))

import { sendReaction, sendMediaMessage } from './whatsapp.js'

describe('sendReaction', () => {
  afterEach(() => vi.restoreAllMocks())

  it('POSTs a reaction payload with message_id + emoji', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: 'wamid.out1' }] }) }))
    const result = await sendReaction('353871234567', 'wamid.target', '👍', { locationId: 'loc1' })
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v21.0/pn1/messages')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '353871234567',
      type: 'reaction',
      reaction: { message_id: 'wamid.target', emoji: '👍' },
    })
    expect(result).toEqual({ messageId: 'wamid.out1' })
  })

  it('empty emoji → sends "" (removes the reaction)', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: 'wamid.out2' }] }) }))
    await sendReaction('353871234567', 'wamid.target', '')
    expect(JSON.parse(fetch.mock.calls[0][1].body).reaction).toEqual({ message_id: 'wamid.target', emoji: '' })
  })

  it('Meta error → throws with the error message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    global.fetch = vi.fn(async () => ({ json: async () => ({ error: { message: 'message too old to react to' } }) }))
    await expect(sendReaction('1', 'wamid.x', '👍')).rejects.toThrow('message too old to react to')
  })
})

describe('sendMediaMessage voice flag', () => {
  afterEach(() => vi.restoreAllMocks())

  it('audio + voice:true → audio object is { link, voice: true } (voice-note render)', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: 'wamid.a1' }] }) }))
    await sendMediaMessage('353871234567', 'audio', 'https://x.test/voice.ogg', null, { voice: true })
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.type).toBe('audio')
    expect(body.audio).toEqual({ link: 'https://x.test/voice.ogg', voice: true })
  })

  it('audio without the flag → no voice key (and no caption — unsupported on audio)', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: 'wamid.a2' }] }) }))
    await sendMediaMessage('353871234567', 'audio', 'https://x.test/a.mp3', 'ignored caption')
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.audio).toEqual({ link: 'https://x.test/a.mp3' })
  })

  it('image path unchanged: { link, caption } even when voice is passed', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: 'wamid.a3' }] }) }))
    await sendMediaMessage('353871234567', 'image', 'https://x.test/p.jpg', 'a caption', { voice: true })
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.type).toBe('image')
    expect(body.image).toEqual({ link: 'https://x.test/p.jpg', caption: 'a caption' })
  })
})
