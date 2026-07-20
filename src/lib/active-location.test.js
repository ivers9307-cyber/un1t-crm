// REPSET-ACCOUNT.2 — the shared set-active-location cookie path.
// Pins the cookie format so the switcher and the Account Home can't
// drift apart (they both write via activeLocationCookieValue).

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  ACTIVE_LOCATION_COOKIE,
  activeLocationCookieValue,
  setActiveLocation,
} from './active-location'

describe('activeLocationCookieValue', () => {
  it('writes the un1t_active_location cookie the switcher reads', () => {
    const v = activeLocationCookieValue('loc-123')
    expect(v.startsWith(`${ACTIVE_LOCATION_COOKIE}=loc-123;`)).toBe(true)
  })

  it('is site-wide (path=/) so /dashboard picks it up', () => {
    expect(activeLocationCookieValue('loc-123')).toContain('path=/')
  })

  it('persists for a year and is SameSite=Lax (unchanged from the switcher)', () => {
    const v = activeLocationCookieValue('loc-123')
    expect(v).toContain(`max-age=${365 * 24 * 60 * 60}`)
    expect(v).toContain('SameSite=Lax')
  })
})

describe('setActiveLocation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is a no-op outside a DOM (safe to import server-side)', () => {
    vi.stubGlobal('document', undefined)
    expect(() => setActiveLocation('loc-123')).not.toThrow()
  })

  it('writes the shared cookie value to document.cookie in the browser', () => {
    const sink = { cookie: '' }
    vi.stubGlobal('document', sink)
    setActiveLocation('loc-xyz')
    expect(sink.cookie).toBe(activeLocationCookieValue('loc-xyz'))
  })
})
