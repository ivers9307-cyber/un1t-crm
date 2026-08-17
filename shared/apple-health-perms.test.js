import { describe, it, expect } from 'vitest'
import { needsAppleHealthResync, HEALTHKIT_READ_TYPES_VERSION } from './apple-health-perms.js'

describe('HEALTHKIT_READ_TYPES_VERSION', () => {
  it('is at least 2 (body types added in Slice 2)', () => {
    expect(HEALTHKIT_READ_TYPES_VERSION).toBeGreaterThanOrEqual(2)
  })
})

describe('needsAppleHealthResync', () => {
  const cur = HEALTHKIT_READ_TYPES_VERSION
  it('false when not connected', () => {
    expect(needsAppleHealthResync({ connected: false, storedVersion: 1, currentVersion: cur })).toBe(false)
    expect(needsAppleHealthResync({ connected: false, storedVersion: null, currentVersion: cur })).toBe(false)
  })
  it('true when connected with no stored version (connected before the marker)', () => {
    expect(needsAppleHealthResync({ connected: true, storedVersion: null, currentVersion: cur })).toBe(true)
  })
  it('true when connected on an older version', () => {
    expect(needsAppleHealthResync({ connected: true, storedVersion: 1, currentVersion: cur })).toBe(true)
  })
  it('false when connected on the current version', () => {
    expect(needsAppleHealthResync({ connected: true, storedVersion: cur, currentVersion: cur })).toBe(false)
  })
  it('false when stored version is somehow ahead', () => {
    expect(needsAppleHealthResync({ connected: true, storedVersion: cur + 1, currentVersion: cur })).toBe(false)
  })
  it('defaults currentVersion to the constant', () => {
    expect(needsAppleHealthResync({ connected: true, storedVersion: 1 })).toBe(true)
  })
})
