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
