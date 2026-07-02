import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock the config module BEFORE importing whatsapp.js so resolveConfig
// resolves a deterministic phone number + token without env/db.
vi.mock('./whatsapp-config', () => ({
  META_API_URL: 'https://graph.facebook.com/v21.0',
  getWhatsAppConfig: vi.fn(async () => ({ phoneNumberId: 'pn1', accessToken: 'tok' })),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
}))

import { setConversationalAutomation } from './whatsapp.js'

describe('setConversationalAutomation', () => {
  afterEach(() => vi.restoreAllMocks())

  it('POSTs the welcome flag + prompts to /conversational_automation', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ success: true }) }))
    await setConversationalAutomation(
      { enableWelcome: true, prompts: ['What classes do you run?', 'How much is membership?'] },
      { locationId: 'loc1' }
    )
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v21.0/pn1/conversational_automation')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({
      enable_welcome_message: true,
      prompts: ['What classes do you run?', 'How much is membership?'],
    })
  })

  it('truncates prompts to 80 chars, drops empties, caps at 4', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({}) }))
    const long = 'x'.repeat(120)
    await setConversationalAutomation({
      enableWelcome: false,
      prompts: [long, '', 'a', 'b', 'c', 'd'],
    })
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.enable_welcome_message).toBe(false)
    expect(body.prompts).toEqual(['x'.repeat(80), 'a', 'b', 'c'])
    expect(body.prompts).toHaveLength(4)
    expect(body.prompts.every((p) => p.length <= 80)).toBe(true)
  })

  it('defaults: welcome on, no prompts', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({}) }))
    await setConversationalAutomation({})
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      enable_welcome_message: true,
      prompts: [],
    })
  })

  it('Meta error → throws with the error message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    global.fetch = vi.fn(async () => ({ json: async () => ({ error: { message: 'ice breakers not supported on this number' } }) }))
    await expect(setConversationalAutomation({ prompts: ['hi'] }))
      .rejects.toThrow('ice breakers not supported on this number')
  })
})
