// src/lib/whatsapp-embedded-signup.test.js
import { describe, it, expect, afterEach } from 'vitest'
import {
  exchangeCodeForBusinessToken, subscribeAppToWaba, probeNumber,
  needsRegistration, generatePin, registerNumber, planPersistence,
  buildSignupMeta,
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

describe('buildSignupMeta', () => {
  const base = {
    wabaId: '555', userId: 'u1', connectedAt: '2026-07-16T00:00:00.000Z',
    probe: { status: 'CONNECTED', platform_type: 'CLOUD_API' },
  }
  it('fresh connect with a pin → meta.pin is the new pin', () => {
    const meta = buildSignupMeta({ ...base, pin: '111111', existingMeta: null })
    expect(meta.pin).toBe('111111')
    expect(meta.waba_id).toBe('555')
    expect(meta.connected_by).toBe('u1')
    expect(meta.connected_at).toBe('2026-07-16T00:00:00.000Z')
    expect(meta.probe).toEqual({ status: 'CONNECTED', platform_type: 'CLOUD_API' })
  })
  it('token-refresh reconnect (pin=null) preserves the previously-stored pin', () => {
    const meta = buildSignupMeta({ ...base, pin: null, existingMeta: { pin: '654321' } })
    expect(meta.pin).toBe('654321')
  })
  it('no pin anywhere → null', () => {
    expect(buildSignupMeta({ ...base, pin: null, existingMeta: null }).pin).toBe(null)
    expect(buildSignupMeta({ ...base, pin: null, existingMeta: {} }).pin).toBe(null)
  })
  it('tolerates a missing probe (defensive nulls)', () => {
    const meta = buildSignupMeta({ ...base, probe: undefined, pin: null, existingMeta: null })
    expect(meta.probe).toEqual({ status: null, platform_type: null })
  })
})

import {
  getWabaPhoneNumber, initialHistorySyncState,
} from './whatsapp-embedded-signup.js'

describe('getWabaPhoneNumber', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  function mockFetch(json) {
    const calls = []
    globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { json: async () => json } }
    return calls
  }
  it('returns the first phone number id + display number for the WABA', async () => {
    const calls = mockFetch({ data: [{ id: '109998', display_phone_number: '+353 1 555 0000', verified_name: 'UN1T Hatch' }] })
    const out = await getWabaPhoneNumber({ wabaId: '555', token: 'T' })
    expect(out).toEqual({ phoneNumberId: '109998', displayPhone: '+353 1 555 0000', verifiedName: 'UN1T Hatch' })
    expect(calls[0].url).toContain('/555/phone_numbers')
    expect(calls[0].opts.headers.Authorization).toBe('Bearer T')
  })
  it('throws with meta metadata on error', async () => {
    mockFetch({ error: { message: 'no access', code: 10, type: 'OAuthException' } })
    await expect(getWabaPhoneNumber({ wabaId: '5', token: 'T' })).rejects.toMatchObject({ message: 'no access', metaCode: 10 })
  })
  it('throws when the WABA has no phone numbers', async () => {
    mockFetch({ data: [] })
    await expect(getWabaPhoneNumber({ wabaId: '5', token: 'T' })).rejects.toThrow(/no phone number/i)
  })
})

describe('initialHistorySyncState', () => {
  it('returns a pending state stamped with the given time', () => {
    expect(initialHistorySyncState('2026-07-16T10:00:00.000Z')).toEqual({ status: 'pending', started_at: '2026-07-16T10:00:00.000Z' })
  })
})
