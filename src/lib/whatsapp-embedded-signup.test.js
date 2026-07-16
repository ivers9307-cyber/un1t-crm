// src/lib/whatsapp-embedded-signup.test.js
import { describe, it, expect, afterEach } from 'vitest'
import {
  exchangeCodeForBusinessToken, subscribeAppToWaba, probeNumber,
  needsRegistration, generatePin, registerNumber, planPersistence,
} from './whatsapp-embedded-signup.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function mockFetch(json) {
  const calls = []
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { json: async () => json } }
  return calls
}

describe('exchangeCodeForBusinessToken', () => {
  it('returns the business token on success', async () => {
    const calls = mockFetch({ access_token: 'BIZ_TOKEN', token_type: 'bearer' })
    const token = await exchangeCodeForBusinessToken({ code: 'abc', appId: '123', appSecret: 'sec' })
    expect(token).toBe('BIZ_TOKEN')
    expect(calls[0].url).toContain('/oauth/access_token')
    expect(calls[0].url).toContain('client_id=123')
    expect(calls[0].url).toContain('code=abc')
  })
  it('throws with meta metadata on error', async () => {
    mockFetch({ error: { message: 'bad code', code: 100, type: 'OAuthException' } })
    await expect(exchangeCodeForBusinessToken({ code: 'x', appId: '1', appSecret: 's' }))
      .rejects.toMatchObject({ message: 'bad code', metaCode: 100 })
  })
  it('throws when the response has no token and no error (defensive)', async () => {
    mockFetch({})
    await expect(exchangeCodeForBusinessToken({ code: 'x', appId: '1', appSecret: 's' }))
      .rejects.toThrow(/exchange failed/i)
  })
})

describe('subscribeAppToWaba', () => {
  it('POSTs to /{waba}/subscribed_apps with the business token', async () => {
    const calls = mockFetch({ success: true })
    await subscribeAppToWaba({ wabaId: '555', token: 'T' })
    expect(calls[0].url).toContain('/555/subscribed_apps')
    expect(calls[0].opts.method).toBe('POST')
    expect(calls[0].opts.headers.Authorization).toBe('Bearer T')
  })
  it('throws on error payloads', async () => {
    mockFetch({ error: { message: 'no perm', code: 200 } })
    await expect(subscribeAppToWaba({ wabaId: '5', token: 'T' })).rejects.toMatchObject({ metaCode: 200 })
  })
})

describe('probeNumber + needsRegistration', () => {
  it('already-registered Cloud API number needs no registration', async () => {
    mockFetch({ status: 'CONNECTED', platform_type: 'CLOUD_API', display_phone_number: '+353 1 234 5678', verified_name: 'UN1T Hatch' })
    const probe = await probeNumber({ phoneNumberId: '999', token: 'T' })
    expect(needsRegistration(probe)).toBe(false)
  })
  it('fresh ES number (NOT_APPLICABLE platform) needs registration', () => {
    expect(needsRegistration({ status: 'PENDING', platform_type: 'NOT_APPLICABLE' })).toBe(true)
  })
  it('missing/odd probe data defaults to needing registration', () => {
    expect(needsRegistration(null)).toBe(true)
    expect(needsRegistration({})).toBe(true)
  })
})

describe('generatePin', () => {
  it('returns a 6-digit numeric string', () => {
    for (let i = 0; i < 20; i++) expect(generatePin()).toMatch(/^\d{6}$/)
  })
})

describe('registerNumber', () => {
  it('POSTs register with messaging_product + pin', async () => {
    const calls = mockFetch({ success: true })
    await registerNumber({ phoneNumberId: '999', token: 'T', pin: '123456' })
    expect(calls[0].url).toContain('/999/register')
    expect(JSON.parse(calls[0].opts.body)).toEqual({ messaging_product: 'whatsapp', pin: '123456' })
  })
  it('surfaces the register rate-limit error verbatim', async () => {
    mockFetch({ error: { message: 'Too many register attempts', code: 133016 } })
    await expect(registerNumber({ phoneNumberId: '9', token: 'T', pin: '000000' }))
      .rejects.toMatchObject({ metaCode: 133016 })
  })
})

describe('planPersistence', () => {
  it('no existing row → insert', () => {
    expect(planPersistence({ existingRow: null, locationId: 'L1' })).toEqual({ action: 'insert' })
  })
  it('existing row in the same location → update (reconnect refresh)', () => {
    expect(planPersistence({ existingRow: { id: 'row1', location_id: 'L1' }, locationId: 'L1' }))
      .toEqual({ action: 'update', id: 'row1' })
  })
  it('existing row owned by ANOTHER location → conflict, never reassign', () => {
    expect(planPersistence({ existingRow: { id: 'row1', location_id: 'L2' }, locationId: 'L1' }))
      .toEqual({ action: 'conflict', owningLocationId: 'L2' })
  })
})
