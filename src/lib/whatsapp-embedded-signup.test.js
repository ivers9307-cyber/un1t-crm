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

describe('planPersistence (WAORGNUMBER.1: a number belongs to an organisation)', () => {
  it('no existing row → insert', () => {
    expect(planPersistence({ existingRow: null, organizationId: 'O1' })).toEqual({ action: 'insert' })
  })
  it('existing row in the same organisation → update (reconnect refresh), whatever its home studio', () => {
    expect(planPersistence({ existingRow: { id: 'row1', organization_id: 'O1', location_id: 'L9' }, organizationId: 'O1' }))
      .toEqual({ action: 'update', id: 'row1' })
  })
  it('existing row owned by ANOTHER organisation → conflict, never reassign', () => {
    expect(planPersistence({ existingRow: { id: 'row1', organization_id: 'O2', location_id: 'L2' }, organizationId: 'O1' }))
      .toEqual({ action: 'conflict', owningOrganizationId: 'O2' })
  })
  it('a row with no organisation is never treated as ours', () => {
    expect(planPersistence({ existingRow: { id: 'row1', organization_id: null }, organizationId: 'O1' }).action).toBe('conflict')
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

// ── COEXSYNC.1 ──────────────────────────────────────────────────────────
import {
  requestSmbAppSync, requestCoexistenceSyncs, SMB_SYNC_API_URL,
} from './whatsapp-embedded-signup.js'

describe('getWabaPhoneNumber picks the number v5 named', () => {
  it('returns the matching row, not the first', async () => {
    globalThis.fetch = async () => ({ json: async () => ({ data: [
      { id: '111', display_phone_number: '+353 1 000 0001', verified_name: 'Other' },
      { id: '222', display_phone_number: '+353 1 000 0002', verified_name: 'Test Studio' },
    ] }) })
    const out = await getWabaPhoneNumber({ wabaId: '5', token: 'T', phoneNumberId: '222' })
    expect(out).toEqual({ phoneNumberId: '222', displayPhone: '+353 1 000 0002', verifiedName: 'Test Studio' })
  })
  it('throws when the named number is not on the WABA', async () => {
    globalThis.fetch = async () => ({ json: async () => ({ data: [{ id: '111' }] }) })
    await expect(getWabaPhoneNumber({ wabaId: '5', token: 'T', phoneNumberId: '999' })).rejects.toThrow(/not on that WhatsApp Business account/)
  })
})

describe('requestSmbAppSync', () => {
  const NOW = '2026-11-17T12:00:00.000Z'
  it('POSTs the sync type to /{id}/smb_app_data on v27.0', async () => {
    const calls = []
    globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ messaging_product: 'whatsapp', request_id: 'r-1' }) } }
    const out = await requestSmbAppSync({ phoneNumberId: '222', token: 'T', syncType: 'history', nowIso: NOW })
    expect(out).toEqual({ ok: true, requested_at: NOW, request_id: 'r-1' })
    expect(calls[0].url).toBe(`${SMB_SYNC_API_URL}/222/smb_app_data`)
    expect(SMB_SYNC_API_URL).toBe('https://graph.facebook.com/v27.0')
    expect(calls[0].opts.method).toBe('POST')
    expect(calls[0].opts.headers.Authorization).toBe('Bearer T')
    expect(JSON.parse(calls[0].opts.body)).toEqual({ messaging_product: 'whatsapp', sync_type: 'history' })
  })
  it('a Meta error is an outcome, not a throw', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'already synced', code: 131000 } }) })
    expect(await requestSmbAppSync({ phoneNumberId: '2', token: 'T', syncType: 'history', nowIso: NOW }))
      .toEqual({ ok: false, attempted_at: NOW, error: 'already synced', meta_code: 131000 })
  })
  it('a network failure is an outcome, not a throw', async () => {
    globalThis.fetch = async () => { throw new Error('socket hang up') }
    expect(await requestSmbAppSync({ phoneNumberId: '2', token: 'T', syncType: 'history', nowIso: NOW }))
      .toEqual({ ok: false, attempted_at: NOW, error: 'socket hang up', meta_code: null })
  })
})

describe('requestCoexistenceSyncs', () => {
  const NOW = '2026-11-17T12:00:00.000Z'
  it('asks for contacts, then history', async () => {
    const asked = []
    const request = async ({ syncType }) => { asked.push(syncType); return { ok: true, requested_at: NOW, request_id: syncType } }
    const out = await requestCoexistenceSyncs({ phoneNumberId: '2', token: 'T', nowIso: NOW, request })
    expect(asked).toEqual(['smb_app_state_sync', 'history'])
    expect(out.history.ok).toBe(true)
  })
  it('never re-asks for a sync Meta already accepted (each is one-shot)', async () => {
    const asked = []
    const request = async ({ syncType }) => { asked.push(syncType); return { ok: true, requested_at: NOW } }
    const existing = { smb_app_state_sync: { ok: true, requested_at: 'earlier' }, history: { ok: false, error: 'x' } }
    const out = await requestCoexistenceSyncs({ phoneNumberId: '2', token: 'T', existing, nowIso: NOW, request })
    expect(asked).toEqual(['history'])
    expect(out.smb_app_state_sync).toEqual({ ok: true, requested_at: 'earlier' })
  })
})
