// HOMEYD.2 — config tests for the tri-state Homey config contract
// (dormant/misconfigured/configured — see the header comment in client.js
// for why the distinction matters). homeyGetDevices/homeySetOnoff are thin
// I/O and intentionally NOT unit tested here (house pattern); reconcile.js
// (HOMEYD.3) injects fakes for them instead.
import { describe, it, expect } from 'vitest'
import { homeyConfigError, getHomeyConfig } from './client.js'

const VALID_URL = 'https://abc123.connect.athom.com'
const VALID_KEY = '  secret-key-123  ' // deliberately padded — must be trimmed
const VALID_UUID = 'a0000000-0000-0000-0000-000000000001'

const validEnv = {
  HOMEY_API_URL: VALID_URL,
  HOMEY_API_KEY: VALID_KEY,
  HOMEY_LOCATION_ID: VALID_UUID,
}

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

  it('returns null for a fully valid trio', () => {
    expect(homeyConfigError(validEnv)).toBeNull()
  })
})

describe('getHomeyConfig', () => {
  it('returns null when fully unset', () => {
    expect(getHomeyConfig({})).toBeNull()
  })

  it('returns { error } when half-configured', () => {
    expect(getHomeyConfig({ HOMEY_API_URL: VALID_URL })).toEqual({
      error: expect.stringMatching(/HOMEY_/),
    })
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

  it('defaults env to process.env when called with no arguments', () => {
    // Just proves the default parameter doesn't throw — doesn't assert on
    // the ambient process.env contents (test-runner-dependent).
    expect(() => getHomeyConfig()).not.toThrow()
  })
})
