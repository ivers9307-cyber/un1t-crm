// C3 — CTA-URL button sends. When an agent outbound text ENDS with a URL,
// the transport layer sends it as Meta's cta_url interactive message (body +
// tappable button) instead of a raw pasted link. Plain text stays byte-
// identical. These tests pin: the splitTrailingUrl contract, the payload
// shape, the sender, and the whatsappAdapter routing (cta_url vs text vs
// fallback-to-text when Meta rejects the cta_url).
import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock the config module BEFORE importing whatsapp.js so resolveConfig
// resolves a deterministic phone number + token without env/db.
vi.mock('./whatsapp-config', () => ({
  META_API_URL: 'https://graph.facebook.com/v21.0',
  getWhatsAppConfig: vi.fn(async () => ({ phoneNumberId: 'pn1', accessToken: 'tok' })),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
}))

import { splitTrailingUrl, buildCtaUrlPayload, sendCtaUrlMessage } from './whatsapp.js'
import { whatsappAdapter } from './agent/auto-reply.js'

describe('splitTrailingUrl', () => {
  it('splits a trailing URL and strips a trailing colon from the body', () => {
    expect(splitTrailingUrl('Book here: https://x.ie/e/race'))
      .toEqual({ body: 'Book here', url: 'https://x.ie/e/race' })
  })

  it('excludes trailing sentence punctuation from the URL', () => {
    expect(splitTrailingUrl('Sign up at https://x.ie/e/race.'))
      .toEqual({ body: 'Sign up at', url: 'https://x.ie/e/race' })
  })

  it('returns null when the text is ONLY a URL (no body left)', () => {
    expect(splitTrailingUrl('https://x.ie/only-a-url')).toBeNull()
  })

  it('returns null when another URL appears earlier (ambiguous)', () => {
    expect(splitTrailingUrl('See https://a.ie and https://b.ie')).toBeNull()
  })

  it('returns null when there is no URL at all', () => {
    expect(splitTrailingUrl('No links here at all')).toBeNull()
  })

  it('keeps a sentence-terminating full stop on the body', () => {
    expect(splitTrailingUrl('Bring a towel. https://x.ie/e/5k'))
      .toEqual({ body: 'Bring a towel.', url: 'https://x.ie/e/5k' })
  })

  it('returns null for a URL mid-sentence (text does not end with it)', () => {
    expect(splitTrailingUrl('https://x.ie is our site, see you soon')).toBeNull()
  })
})

describe('buildCtaUrlPayload', () => {
  it('builds the Meta interactive cta_url shape', () => {
    const p = buildCtaUrlPayload('353871234567', {
      bodyText: 'Book here', buttonText: 'Open link', url: 'https://x.ie/e/race',
    })
    expect(p.messaging_product).toBe('whatsapp')
    expect(p.to).toBe('353871234567')
    expect(p.type).toBe('interactive')
    expect(p.interactive.type).toBe('cta_url')
    expect(p.interactive.body).toEqual({ text: 'Book here' })
    expect(p.interactive.action.name).toBe('cta_url')
    expect(p.interactive.action.parameters).toEqual({
      display_text: 'Open link', url: 'https://x.ie/e/race',
    })
  })
})

describe('sendCtaUrlMessage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('POSTs the cta_url payload and returns the message id', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: 'wamid.CTA' }] }) }))
    const r = await sendCtaUrlMessage('353871234567', {
      bodyText: 'Book here', buttonText: 'Open link', url: 'https://x.ie/e/race',
    }, { locationId: 'loc1' })
    expect(r).toEqual({ messageId: 'wamid.CTA', status: 'sent' })
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v21.0/pn1/messages')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.interactive.type).toBe('cta_url')
    expect(body.interactive.action.parameters.url).toBe('https://x.ie/e/race')
  })

  it('Meta error → throws with the error message', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ error: { message: 'invalid url' } }) }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(sendCtaUrlMessage('1', { bodyText: 'B', buttonText: 'Open', url: 'https://x.ie' }))
      .rejects.toThrow('invalid url')
    errSpy.mockRestore()
  })
})

// The adapter calls the real whatsapp.js senders, which call fetch — so the
// routing decision (cta_url vs plain text vs fallback) is asserted from the
// fetch bodies, not from module mocks.
describe('whatsappAdapter.send — C3 routing', () => {
  afterEach(() => vi.restoreAllMocks())

  it('text ending in a URL → cta_url send with the default button text', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: 'wamid.1' }] }) }))
    const r = await whatsappAdapter.send('353871234567', 'Book here: https://x.ie/e/race', { locationId: 'loc1' })
    expect(r.messageId).toBe('wamid.1')
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.type).toBe('interactive')
    expect(body.interactive.type).toBe('cta_url')
    expect(body.interactive.body.text).toBe('Book here')
    expect(body.interactive.action.parameters).toEqual({
      display_text: 'Open link', url: 'https://x.ie/e/race',
    })
  })

  it('operator-set settings.link_button_text overrides the button label', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: 'wamid.2' }] }) }))
    await whatsappAdapter.send('353871234567', 'Book here: https://x.ie/e/race', {
      locationId: 'loc1', settings: { link_button_text: 'Book now' },
    })
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.interactive.action.parameters.display_text).toBe('Book now')
  })

  it('plain text (no trailing URL) → ordinary text send, byte-identical', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: 'wamid.3' }] }) }))
    await whatsappAdapter.send('353871234567', 'See you at 7am tomorrow!', { locationId: 'loc1' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.type).toBe('text')
    expect(body.text).toEqual({ body: 'See you at 7am tomorrow!' })
  })

  it('cta_url rejected by Meta → falls back to a plain text send of the FULL text', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ error: { message: 'cta_url not supported' } }) })
      .mockResolvedValueOnce({ json: async () => ({ messages: [{ id: 'wamid.4' }] }) })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await whatsappAdapter.send('353871234567', 'Book here: https://x.ie/e/race', { locationId: 'loc1' })
    errSpy.mockRestore(); warnSpy.mockRestore()
    expect(r.messageId).toBe('wamid.4')
    expect(fetch).toHaveBeenCalledTimes(2)
    const first = JSON.parse(fetch.mock.calls[0][1].body)
    expect(first.interactive.type).toBe('cta_url')
    const second = JSON.parse(fetch.mock.calls[1][1].body)
    expect(second.type).toBe('text')
    expect(second.text.body).toBe('Book here: https://x.ie/e/race')
  })
})
