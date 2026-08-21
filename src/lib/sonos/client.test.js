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

import {
  sonosGetHouseholds,
  sonosGetGroups,
  sonosGetFavorites,
  sonosSetGroupVolume,
  sonosLoadFavorite,
  sonosPause,
} from './client'

describe('control api calls', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { vi.restoreAllMocks() })

  const okEmpty = { ok: true, status: 200, text: async () => '{}' }

  it('gets groups for a household with a bearer token and a user-agent', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => '{"groups":[],"players":[]}' })
    const out = await sonosGetGroups('tok', 'Sonos_HH1')
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.ws.sonos.com/control/api/v1/households/Sonos_HH1/groups')
    expect(opts.headers.authorization).toBe('Bearer tok')
    expect(opts.headers['user-agent']).toBeTruthy()
    expect(opts.headers['content-type']).toBeUndefined()
    expect(out).toMatchObject({ ok: true, statusCode: 200 })
  })

  it('gets households with a bearer token', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => '{"households":[]}' })
    await sonosGetHouseholds('tok')
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.ws.sonos.com/control/api/v1/households')
    expect(opts.headers.authorization).toBe('Bearer tok')
  })

  it('gets favorites for a household', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => '{"items":[]}' })
    await sonosGetFavorites('tok', 'Sonos_HH1')
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.ws.sonos.com/control/api/v1/households/Sonos_HH1/favorites')
    expect(opts.headers.authorization).toBe('Bearer tok')
  })

  it('url-encodes a household id', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosGetGroups('tok', 'HH/with slash')
    expect(global.fetch.mock.calls[0][0]).toContain('HH%2Fwith%20slash')
  })

  it('posts group volume as an integer body', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosSetGroupVolume('tok', 'GRP1', 35)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.ws.sonos.com/control/api/v1/groups/GRP1/groupVolume')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ volume: 35 })
  })

  it('clamps volume into the 0-100 range Sonos accepts', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosSetGroupVolume('tok', 'GRP1', 140)
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ volume: 100 })
    await sonosSetGroupVolume('tok', 'GRP1', -5)
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ volume: 0 })
  })

  it('loads a favourite and starts playback', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosLoadFavorite('tok', 'GRP1', 'fv-1')
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.ws.sonos.com/control/api/v1/groups/GRP1/favorites')
    expect(JSON.parse(opts.body)).toEqual({ favoriteId: 'fv-1', playOnCompletion: true })
  })

  it('pauses a group', async () => {
    global.fetch.mockResolvedValue(okEmpty)
    await sonosPause('tok', 'GRP1')
    expect(global.fetch.mock.calls[0][0])
      .toBe('https://api.ws.sonos.com/control/api/v1/groups/GRP1/playback/pause')
  })

  it('never throws when the network dies mid-command', async () => {
    global.fetch.mockRejectedValue(new Error('ETIMEDOUT'))
    await expect(sonosPause('tok', 'GRP1')).resolves.toMatchObject({ ok: false, statusCode: 0 })
  })
})

import { withFreshToken } from './client'

function fakeDb(conn, captured = {}, opts = {}) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: opts.selectError ? null : conn,
            error: opts.selectError || null,
          }),
        }),
      }),
      update: (patch) => {
        captured.patch = patch
        return { eq: async () => ({ error: opts.updateError || null }) }
      },
    }),
    _captured: captured,
  }
}

describe('withFreshToken', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => { vi.restoreAllMocks() })

  it('returns the stored token when it is still fresh', async () => {
    const conn = {
      id: 'c1', household_id: 'HH1', refresh_token: 'rt', access_token: 'at',
      access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }
    const out = await withFreshToken(fakeDb(conn), 'loc-1', cfg)
    expect(out).toMatchObject({ ok: true, token: 'at', householdId: 'HH1' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('refreshes when inside the expiry margin and persists only the access token', async () => {
    const captured = {}
    const conn = {
      id: 'c1', household_id: 'HH1', refresh_token: 'rt', access_token: 'old',
      access_token_expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
    }
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ access_token: 'new', refresh_token: 'rt', expires_in: 86400 }),
    })
    const out = await withFreshToken(fakeDb(conn, captured), 'loc-1', cfg)
    expect(out).toMatchObject({ ok: true, token: 'new' })
    expect(captured.patch.access_token).toBe('new')
    expect(captured.patch).not.toHaveProperty('refresh_token')
  })

  it('reports not-connected rather than throwing when there is no row', async () => {
    const out = await withFreshToken(fakeDb(null), 'loc-1', cfg)
    expect(out).toMatchObject({ ok: false, reason: 'not_connected' })
  })

  it('reports a revoked grant so the UI can prompt a re-link', async () => {
    const conn = {
      id: 'c1', household_id: 'HH1', refresh_token: 'rt', access_token: 'old',
      access_token_expires_at: new Date(Date.now() - 1000).toISOString(),
    }
    global.fetch.mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' })
    const out = await withFreshToken(fakeDb(conn), 'loc-1', cfg)
    expect(out).toMatchObject({ ok: false, reason: 'refresh_failed', statusCode: 400 })
  })

  it('reports a db_error rather than throwing when the lookup select fails', async () => {
    const out = await withFreshToken(
      fakeDb(null, {}, { selectError: { message: 'connection refused' } }),
      'loc-1',
      cfg,
    )
    expect(out).toMatchObject({ ok: false, reason: 'db_error' })
  })

  it('reports a db_error rather than throwing when persisting the refreshed token fails', async () => {
    const conn = {
      id: 'c1', household_id: 'HH1', refresh_token: 'rt', access_token: 'old',
      access_token_expires_at: new Date(Date.now() - 1000).toISOString(),
    }
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ access_token: 'new', refresh_token: 'rt', expires_in: 86400 }),
    })
    const out = await withFreshToken(
      fakeDb(conn, {}, { updateError: { message: 'write conflict' } }),
      'loc-1',
      cfg,
    )
    expect(out).toMatchObject({ ok: false, reason: 'db_error' })
  })
})
