import { describe, it, expect } from 'vitest'
import { sonosConfigError, getSonosConfig } from './client'

const full = {
  SONOS_CLIENT_ID: 'abc',
  SONOS_CLIENT_SECRET: 'shhh',
  SONOS_REDIRECT_URI: 'https://crm.repset.ie/api/sonos/callback',
}

describe('sonosConfigError', () => {
  it('returns null when nothing is set (dormant, not an error)', () => {
    expect(sonosConfigError({})).toBe(null)
  })

  it('names every missing var when half-configured', () => {
    const err = sonosConfigError({ SONOS_CLIENT_ID: 'abc' })
    expect(err).toContain('SONOS_CLIENT_SECRET')
    expect(err).toContain('SONOS_REDIRECT_URI')
  })

  it('never leaks the secret value into the error', () => {
    const err = sonosConfigError({ SONOS_CLIENT_ID: 'abc', SONOS_CLIENT_SECRET: 'shhh' })
    expect(err).not.toContain('shhh')
  })

  it('rejects a non-HTTPS redirect (Sonos requires HTTPS and publicly routable)', () => {
    const err = sonosConfigError({ ...full, SONOS_REDIRECT_URI: 'http://localhost:3000/api/sonos/callback' })
    expect(err).toContain('HTTPS')
  })

  it('returns null when fully valid', () => {
    expect(sonosConfigError(full)).toBe(null)
  })
})

describe('getSonosConfig', () => {
  it('is dormant when unset', () => {
    expect(getSonosConfig({})).toBe(null)
  })

  it('reports the error object when half-set', () => {
    expect(getSonosConfig({ SONOS_CLIENT_ID: 'abc' })).toHaveProperty('error')
  })

  it('trims pasted whitespace off the credentials', () => {
    expect(getSonosConfig({ ...full, SONOS_CLIENT_ID: ' abc \n' })).toMatchObject({ clientId: 'abc' })
  })
})

import { vi, beforeEach, afterEach } from 'vitest'
import { buildAuthorizeUrl, exchangeCode, refreshAccessToken } from './client'

const cfg = {
  clientId: 'abc',
  clientSecret: 'shhh',
  redirectUri: 'https://crm.repset.ie/api/sonos/callback',
}

describe('buildAuthorizeUrl', () => {
  it('requests the only scope Sonos offers, with the state echoed back', () => {
    const url = new URL(buildAuthorizeUrl(cfg, 'state-123'))
    expect(url.origin + url.pathname).toBe('https://api.sonos.com/login/v3/oauth')
    expect(url.searchParams.get('client_id')).toBe('abc')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('playback-control-all')
    expect(url.searchParams.get('state')).toBe('state-123')
    expect(url.searchParams.get('redirect_uri')).toBe(cfg.redirectUri)
  })
})

describe('token calls', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { vi.restoreAllMocks() })

  it('sends client credentials as HTTP Basic, not in the body', async () => {
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 86400 }),
    })
    await exchangeCode(cfg, 'the-code')
    const [, opts] = global.fetch.mock.calls[0]
    expect(opts.headers.authorization).toBe(`Basic ${Buffer.from('abc:shhh').toString('base64')}`)
    expect(String(opts.body)).not.toContain('shhh')
  })

  it('returns the parsed token payload on success', async () => {
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 86400 }),
    })
    const out = await exchangeCode(cfg, 'the-code')
    expect(out).toMatchObject({ ok: true, body: { access_token: 'at', refresh_token: 'rt' } })
  })

  it('returns body: null when the response is not JSON', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'not json at all' })
    const out = await exchangeCode(cfg, 'the-code')
    expect(out).toEqual({ ok: true, statusCode: 200, body: null })
  })

  it('never throws on a network failure', async () => {
    global.fetch.mockRejectedValue(new Error('ECONNRESET'))
    const out = await refreshAccessToken(cfg, 'rt')
    expect(out).toMatchObject({ ok: false, statusCode: 0, networkError: true })
  })

  it('surfaces a 400 without leaking the secret', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' })
    const out = await refreshAccessToken(cfg, 'rt')
    expect(out.ok).toBe(false)
    expect(out.statusCode).toBe(400)
    expect(JSON.stringify(out)).not.toContain('shhh')
  })
})
