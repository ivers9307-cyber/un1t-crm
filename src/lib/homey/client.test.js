// HOMEYD.2 — tests for the tri-state Homey config contract
// (dormant/misconfigured/configured — see the header comment in client.js
// for why the distinction matters) AND the thin fetch wrappers
// (homeyGetDevices/homeySetOnoff), which are unit tested here against a
// mocked global.fetch — house pattern per sensibo.js/sensibo.test.js and
// thinq.js/thinq.test.js, not the "thin I/O is untested" assumption the
// original HOMEYD.2 cut made.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homeyConfigError, getHomeyConfig, homeyGetDevices, homeySetOnoff } from './client.js'

const VALID_URL = 'https://abc123.connect.athom.com'
const VALID_KEY = '  secret-key-123  ' // deliberately padded — must be trimmed
const VALID_UUID = 'a0000000-0000-0000-0000-000000000001'
const SECRET_KEY = 'sk-SECRET-XYZ' // distinctive fixture for the leak-assertion test

const validEnv = {
  HOMEY_API_URL: VALID_URL,
  HOMEY_API_KEY: VALID_KEY,
  HOMEY_LOCATION_ID: VALID_UUID,
}

// ----------------------------------------------------------------
// homeyConfigError
// ----------------------------------------------------------------

describe('homeyConfigError', () => {
  it('returns null when all three vars are fully unset — dormant, not an error', () => {
    expect(homeyConfigError({})).toBeNull()
    expect(homeyConfigError({ HOMEY_API_URL: '', HOMEY_API_KEY: undefined, HOMEY_LOCATION_ID: '   ' })).toBeNull()
  })

  it('returns an error naming the missing vars when only HOMEY_API_URL is set', () => {
    const err = homeyConfigError({ HOMEY_API_URL: VALID_URL })
    expect(err).toMatch(/HOMEY_/)
    expect(err).toMatch(/HOMEY_API_KEY/)
    expect(err).toMatch(/HOMEY_LOCATION_ID/)
  })

  it('returns an error naming the missing vars when only HOMEY_API_KEY is set', () => {
    const err = homeyConfigError({ HOMEY_API_KEY: 'some-key' })
    expect(err).toMatch(/HOMEY_/)
    expect(err).toMatch(/HOMEY_API_URL/)
    expect(err).toMatch(/HOMEY_LOCATION_ID/)
  })

  it('returns an error naming the missing vars when only HOMEY_LOCATION_ID is set', () => {
    const err = homeyConfigError({ HOMEY_LOCATION_ID: VALID_UUID })
    expect(err).toMatch(/HOMEY_/)
    expect(err).toMatch(/HOMEY_API_URL/)
    expect(err).toMatch(/HOMEY_API_KEY/)
  })

  // 2-of-3 combos — pin against a `missing.length === 1 → null` loosening
  // that would let a half-configured env fall through to `new URL(undefined)`
  // in getHomeyConfig and throw out of the cron path instead of erroring cleanly.
  it('returns an error naming HOMEY_LOCATION_ID when URL+key are set but location id is not', () => {
    const err = homeyConfigError({ HOMEY_API_URL: VALID_URL, HOMEY_API_KEY: 'some-key' })
    expect(err).toMatch(/HOMEY_/)
    expect(err).toMatch(/HOMEY_LOCATION_ID/)
  })

  it('returns an error naming HOMEY_API_KEY when URL+location id are set but key is not', () => {
    const err = homeyConfigError({ HOMEY_API_URL: VALID_URL, HOMEY_LOCATION_ID: VALID_UUID })
    expect(err).toMatch(/HOMEY_/)
    expect(err).toMatch(/HOMEY_API_KEY/)
  })

  it('returns an error naming HOMEY_API_URL when key+location id are set but URL is not', () => {
    const err = homeyConfigError({ HOMEY_API_KEY: 'some-key', HOMEY_LOCATION_ID: VALID_UUID })
    expect(err).toMatch(/HOMEY_/)
    expect(err).toMatch(/HOMEY_API_URL/)
  })

  it('rejects a path-bearing URL, naming the web-app-URL mis-paste', () => {
    const err = homeyConfigError({ ...validEnv, HOMEY_API_URL: 'https://my.homey.app/homey/abc' })
    expect(err).toMatch(/HOMEY_/)
    expect(err).toMatch(/origin/i)
  })

  it('rejects a URL with a query string', () => {
    const err = homeyConfigError({ ...validEnv, HOMEY_API_URL: 'https://abc123.connect.athom.com?foo=bar' })
    expect(err).toMatch(/HOMEY_/)
  })

  it('rejects a URL with a hash fragment', () => {
    const err = homeyConfigError({ ...validEnv, HOMEY_API_URL: 'https://abc123.connect.athom.com#frag' })
    expect(err).toMatch(/HOMEY_/)
  })

  it('rejects a non-http(s) protocol', () => {
    const err = homeyConfigError({ ...validEnv, HOMEY_API_URL: 'ftp://abc123.connect.athom.com' })
    expect(err).toMatch(/HOMEY_/)
  })

  it('rejects an unparseable URL', () => {
    const err = homeyConfigError({ ...validEnv, HOMEY_API_URL: 'not a url at all' })
    expect(err).toMatch(/HOMEY_/)
  })

  it('rejects a whitespace-only API key', () => {
    const err = homeyConfigError({ ...validEnv, HOMEY_API_KEY: '   ' })
    expect(err).toMatch(/HOMEY_API_KEY/)
  })

  it('rejects a location id that is not a valid UUID', () => {
    const err = homeyConfigError({ ...validEnv, HOMEY_LOCATION_ID: 'not-a-uuid' })
    expect(err).toMatch(/HOMEY_LOCATION_ID/)
  })

  it('accepts a location id with surrounding whitespace/newline (trimmed before validation)', () => {
    expect(homeyConfigError({ ...validEnv, HOMEY_LOCATION_ID: `${VALID_UUID}\n` })).toBeNull()
    expect(homeyConfigError({ ...validEnv, HOMEY_LOCATION_ID: `  ${VALID_UUID}  ` })).toBeNull()
  })

  it('returns null for a fully valid trio', () => {
    expect(homeyConfigError(validEnv)).toBeNull()
  })

  it('never leaks the API key value in any error message across the matrix', () => {
    const cases = [
      {},
      { HOMEY_API_URL: VALID_URL },
      { HOMEY_API_KEY: SECRET_KEY },
      { HOMEY_LOCATION_ID: VALID_UUID },
      { HOMEY_API_URL: VALID_URL, HOMEY_API_KEY: SECRET_KEY },
      { HOMEY_API_KEY: SECRET_KEY, HOMEY_LOCATION_ID: VALID_UUID },
      { HOMEY_API_URL: 'https://my.homey.app/homey/abc', HOMEY_API_KEY: SECRET_KEY, HOMEY_LOCATION_ID: VALID_UUID },
      { HOMEY_API_URL: 'ftp://x.example.com', HOMEY_API_KEY: SECRET_KEY, HOMEY_LOCATION_ID: VALID_UUID },
      { HOMEY_API_URL: 'not a url', HOMEY_API_KEY: SECRET_KEY, HOMEY_LOCATION_ID: VALID_UUID },
      { HOMEY_API_URL: VALID_URL, HOMEY_API_KEY: '   ', HOMEY_LOCATION_ID: VALID_UUID },
      { HOMEY_API_URL: VALID_URL, HOMEY_API_KEY: SECRET_KEY, HOMEY_LOCATION_ID: 'not-a-uuid' },
    ]
    for (const env of cases) {
      const err = homeyConfigError(env)
      if (err) expect(err).not.toContain(SECRET_KEY)
    }
  })
})

// ----------------------------------------------------------------
// getHomeyConfig
// ----------------------------------------------------------------

describe('getHomeyConfig', () => {
  it('returns null when fully unset', () => {
    expect(getHomeyConfig({})).toBeNull()
  })

  it('returns { error } when half-configured', () => {
    expect(getHomeyConfig({ HOMEY_API_URL: VALID_URL })).toEqual({
      error: expect.stringMatching(/HOMEY_/),
    })
  })

  it('returns { error } for each 2-of-3 combo without throwing', () => {
    expect(() => getHomeyConfig({ HOMEY_API_URL: VALID_URL, HOMEY_API_KEY: 'k' })).not.toThrow()
    expect(getHomeyConfig({ HOMEY_API_URL: VALID_URL, HOMEY_API_KEY: 'k' }).error).toMatch(/HOMEY_LOCATION_ID/)

    expect(() => getHomeyConfig({ HOMEY_API_URL: VALID_URL, HOMEY_LOCATION_ID: VALID_UUID })).not.toThrow()
    expect(getHomeyConfig({ HOMEY_API_URL: VALID_URL, HOMEY_LOCATION_ID: VALID_UUID }).error).toMatch(/HOMEY_API_KEY/)

    expect(() => getHomeyConfig({ HOMEY_API_KEY: 'k', HOMEY_LOCATION_ID: VALID_UUID })).not.toThrow()
    expect(getHomeyConfig({ HOMEY_API_KEY: 'k', HOMEY_LOCATION_ID: VALID_UUID }).error).toMatch(/HOMEY_API_URL/)
  })

  it('returns { error } when the URL carries a path', () => {
    const out = getHomeyConfig({ ...validEnv, HOMEY_API_URL: 'https://my.homey.app/homey/abc' })
    expect(out.error).toMatch(/origin/i)
  })

  it('returns an origin-normalised, trimmed config for a fully valid trio', () => {
    expect(getHomeyConfig(validEnv)).toEqual({
      url: 'https://abc123.connect.athom.com',
      apiKey: 'secret-key-123',
      locationId: VALID_UUID,
    })
  })

  it('strips a trailing slash from the URL via origin normalisation', () => {
    const out = getHomeyConfig({ ...validEnv, HOMEY_API_URL: 'https://abc123.connect.athom.com/' })
    expect(out.url).toBe('https://abc123.connect.athom.com')
  })

  it('trims a trailing newline off the location id in the returned config', () => {
    const out = getHomeyConfig({ ...validEnv, HOMEY_LOCATION_ID: `${VALID_UUID}\n` })
    expect(out.locationId).toBe(VALID_UUID)
  })

  it('defaults env to process.env when called with no arguments', () => {
    // Just proves the default parameter doesn't throw — doesn't assert on
    // the ambient process.env contents (test-runner-dependent).
    expect(() => getHomeyConfig()).not.toThrow()
  })
})

// ----------------------------------------------------------------
// homeyGetDevices / homeySetOnoff — mocked global.fetch
// ----------------------------------------------------------------

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }
}

function textResponse(text, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  }
}

const cfg = { url: 'https://abc123.connect.athom.com', apiKey: SECRET_KEY }

let originalFetch
beforeEach(() => {
  originalFetch = global.fetch
})
afterEach(() => {
  global.fetch = originalFetch
})

describe('homeyGetDevices', () => {
  it('GETs the exact devices path with a Bearer header and no content-type', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ 'dev-1': { id: 'dev-1' } }))
    const out = await homeyGetDevices(cfg)

    const [url, init] = global.fetch.mock.calls[0]
    expect(String(url)).toBe('https://abc123.connect.athom.com/api/manager/devices/device')
    expect(init.method).toBe('GET')
    expect(init.headers.authorization).toBe(`Bearer ${SECRET_KEY}`)
    expect(init.headers['content-type']).toBeUndefined()
    expect(out).toEqual({ ok: true, statusCode: 200, body: { 'dev-1': { id: 'dev-1' } } })
  })

  it('returns ok:false + statusCode on a non-2xx response, with the parsed body', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ error: 'Unauthorized' }, { status: 401 }))
    const out = await homeyGetDevices(cfg)
    expect(out).toEqual({ ok: false, statusCode: 401, body: { error: 'Unauthorized' } })
  })

  it('returns body: null when the response is not JSON', async () => {
    global.fetch = vi.fn(async () => textResponse('<html>not json</html>'))
    const out = await homeyGetDevices(cfg)
    expect(out).toEqual({ ok: true, statusCode: 200, body: null })
  })

  it('never rejects when fetch throws — resolves the networkError shape', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNRESET') })
    await expect(homeyGetDevices(cfg)).resolves.toEqual({
      ok: false, statusCode: 0, networkError: true, body: null,
    })
  })
})

describe('homeySetOnoff', () => {
  it('PUTs the capability path with the homey: prefix stripped and id encoded', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ id: 'a/b', value: true }))
    const out = await homeySetOnoff(cfg, 'homey:a/b', true)

    const [url, init] = global.fetch.mock.calls[0]
    expect(String(url)).toBe(
      'https://abc123.connect.athom.com/api/manager/devices/device/a%2Fb/capability/onoff'
    )
    expect(init.method).toBe('PUT')
    expect(init.headers.authorization).toBe(`Bearer ${SECRET_KEY}`)
    expect(init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ value: true })
    expect(out.ok).toBe(true)
  })

  it('sends { value: false } when turning a device off', async () => {
    global.fetch = vi.fn(async () => jsonResponse({}))
    await homeySetOnoff(cfg, 'homey:abc-1', false)
    const [, init] = global.fetch.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ value: false })
  })

  it('does not double-strip an id with no homey: prefix', async () => {
    global.fetch = vi.fn(async () => jsonResponse({}))
    await homeySetOnoff(cfg, 'abc-1', true)
    const [url] = global.fetch.mock.calls[0]
    expect(String(url)).toContain('/device/abc-1/capability/onoff')
  })

  it('returns ok:false + statusCode + parsed body on a non-2xx response', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ error: 'device not found' }, { status: 404 }))
    const out = await homeySetOnoff(cfg, 'homey:missing', true)
    expect(out).toEqual({ ok: false, statusCode: 404, body: { error: 'device not found' } })
  })

  it('never rejects when fetch throws — resolves the networkError shape', async () => {
    global.fetch = vi.fn(async () => { throw new Error('timeout') })
    await expect(homeySetOnoff(cfg, 'homey:abc-1', true)).resolves.toEqual({
      ok: false, statusCode: 0, networkError: true, body: null,
    })
  })

  it('never rejects for a non-string device id (coerced via String())', async () => {
    global.fetch = vi.fn(async () => jsonResponse({}))
    await expect(homeySetOnoff(cfg, 123, true)).resolves.toMatchObject({ ok: true })
    const [url] = global.fetch.mock.calls[0]
    expect(String(url)).toContain('/device/123/capability/onoff')
  })

  it('never rejects for a null/undefined device id', async () => {
    global.fetch = vi.fn(async () => jsonResponse({}))
    await expect(homeySetOnoff(cfg, null, true)).resolves.toMatchObject({ ok: true })
    await expect(homeySetOnoff(cfg, undefined, true)).resolves.toMatchObject({ ok: true })
  })
})
