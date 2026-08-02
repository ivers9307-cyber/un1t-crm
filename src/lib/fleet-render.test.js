// FLEET-CMD.2 — the render heartbeat's input handling.
//
// `?device=` arrives on a PUBLIC, unauthenticated endpoint, so what it accepts
// matters more than what it does with it.

import { describe, it, expect } from 'vitest'
import { deviceFromRequest, RENDER_STAMP_THROTTLE_SECONDS } from './fleet-render.js'

const req = (url) => new Request(url)

describe('deviceFromRequest', () => {
  it('reads a fleet device name', () => {
    expect(deviceFromRequest(req('https://x/api/public/live/loc?device=stillorgan-tv1')))
      .toBe('stillorgan-tv1')
  })

  it('is absent for every other viewer of the board', () => {
    // A laptop, the promo TV, the token-gated page — none pass a device, and
    // none should be treated as one.
    expect(deviceFromRequest(req('https://x/api/public/live/loc'))).toBeNull()
    expect(deviceFromRequest(req('https://x/api/public/live/loc?device='))).toBeNull()
  })

  it('refuses anything outside a hostname alphabet', () => {
    // Device names are Tailscale hostnames. Nothing else can be one, and the
    // value reaches a query on an unauthenticated route.
    for (const bad of [
      'Stillorgan-TV1',          // uppercase
      "tv1' or '1'='1",          // quote
      'tv1;drop',                // semicolon
      'tv1 tv2',                 // space
      '../etc/passwd',           // traversal
      'tv1%00',                  // encoded null
      'tv1*',                    // wildcard
    ]) {
      expect(deviceFromRequest(req(`https://x/live?device=${encodeURIComponent(bad)}`)), bad)
        .toBeNull()
    }
  })

  it('never throws on a url it cannot parse', () => {
    // This runs on the request that renders the board. A relative url (route
    // tests use one), a missing url, a junk object — none may break the TV.
    expect(deviceFromRequest({ url: '/api/public/live/loc?device=tv1' })).toBeNull()
    expect(deviceFromRequest({ url: '' })).toBeNull()
    expect(deviceFromRequest({})).toBeNull()
    expect(deviceFromRequest(null)).toBeNull()
  })

  it('caps the length', () => {
    expect(deviceFromRequest(req(`https://x/live?device=${'a'.repeat(65)}`))).toBeNull()
    expect(deviceFromRequest(req(`https://x/live?device=${'a'.repeat(64)}`))).toBe('a'.repeat(64))
  })
})

describe('throttle', () => {
  it('is far coarser than the poll cadence', () => {
    // The board polls every 4s. Writing on each one would be ~900 rows/hour per
    // screen to record something that changes about monthly, and the staleness
    // threshold is 10 minutes — a minute of resolution is already generous.
    expect(RENDER_STAMP_THROTTLE_SECONDS).toBeGreaterThanOrEqual(30)
    expect(RENDER_STAMP_THROTTLE_SECONDS).toBeLessThan(10 * 60)
  })
})
