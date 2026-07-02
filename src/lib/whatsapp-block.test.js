import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock the config module BEFORE importing whatsapp.js so resolveConfig
// resolves a deterministic phone number + token without env/db.
vi.mock('./whatsapp-config', () => ({
  META_API_URL: 'https://graph.facebook.com/v21.0',
  getWhatsAppConfig: vi.fn(async () => ({ phoneNumberId: 'pn1', accessToken: 'tok' })),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
}))

import { setWhatsAppUserBlockState } from './whatsapp.js'

describe('setWhatsAppUserBlockState', () => {
  afterEach(() => vi.restoreAllMocks())

  it('block → POST /block_users with the user payload', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ block_users: { added_users: [{ input: '353871234567' }] } }) }))
    await setWhatsAppUserBlockState('353871234567', true, { locationId: 'loc1' })
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v21.0/pn1/block_users')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ messaging_product: 'whatsapp', block_users: [{ user: '353871234567' }] })
  })

  it('unblock → DELETE /block_users', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({}) }))
    await setWhatsAppUserBlockState('353871234567', false)
    expect(fetch.mock.calls[0][1].method).toBe('DELETE')
  })

  it('Meta error → throws with the error message', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ error: { message: 'cannot block: no recent message' } }) }))
    await expect(setWhatsAppUserBlockState('1', true)).rejects.toThrow('cannot block: no recent message')
  })
})
