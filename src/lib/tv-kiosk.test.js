import { describe, it, expect } from 'vitest'
import { isKioskParam, showReconnecting } from './tv-kiosk.js'

describe('isKioskParam', () => {
  it('true for ?kiosk=1', () => {
    expect(isKioskParam('?kiosk=1')).toBe(true)
    expect(isKioskParam('?foo=bar&kiosk=1')).toBe(true)
  })
  it('false otherwise', () => {
    expect(isKioskParam('')).toBe(false)
    expect(isKioskParam('?kiosk=0')).toBe(false)
    expect(isKioskParam('?other=1')).toBe(false)
    expect(isKioskParam(null)).toBe(false)
  })
})

describe('showReconnecting', () => {
  it('shows once failures reach the threshold (default 2)', () => {
    expect(showReconnecting({ consecutiveFailures: 0 })).toBe(false)
    expect(showReconnecting({ consecutiveFailures: 1 })).toBe(false)
    expect(showReconnecting({ consecutiveFailures: 2 })).toBe(true)
    expect(showReconnecting({ consecutiveFailures: 5 })).toBe(true)
  })
  it('handles junk', () => {
    expect(showReconnecting({})).toBe(false)
    expect(showReconnecting()).toBe(false)
  })
})
