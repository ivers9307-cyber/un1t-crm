// W0.9a — the TV clients' poll URL. One helper so the location-keyed and the
// token-gated entrypoints append the FLEET-CMD.2 ?device= identically.

import { describe, it, expect } from 'vitest'
import { withDevice } from './tv-data-url.js'

describe('withDevice', () => {
  it('leaves the url alone without a device', () => {
    expect(withDevice('/api/public/live/loc-1', null)).toBe('/api/public/live/loc-1')
    expect(withDevice('/api/public/tv-live/tok-1', undefined)).toBe('/api/public/tv-live/tok-1')
    expect(withDevice('/api/public/tv-live/tok-1', '')).toBe('/api/public/tv-live/tok-1')
  })

  it('appends ?device= to a location-keyed url (unchanged behaviour)', () => {
    expect(withDevice('/api/public/live/loc-1', 'kiosk-1')).toBe('/api/public/live/loc-1?device=kiosk-1')
  })

  it('appends ?device= to a token endpoint', () => {
    expect(withDevice('/api/public/tv-live/tok-1', 'kiosk-1')).toBe('/api/public/tv-live/tok-1?device=kiosk-1')
    expect(withDevice('/api/public/tv-challenges/tok-1', 'kiosk-1')).toBe('/api/public/tv-challenges/tok-1?device=kiosk-1')
  })

  it('uses & when the url already has a query string', () => {
    expect(withDevice('/api/public/tv-live/tok-1?x=1', 'kiosk-1')).toBe('/api/public/tv-live/tok-1?x=1&device=kiosk-1')
  })

  it('url-encodes the device name', () => {
    expect(withDevice('/api/public/tv-live/tok-1', 'a b&c')).toBe('/api/public/tv-live/tok-1?device=a%20b%26c')
  })
})
