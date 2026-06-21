// mobile/lib/studio-pin-lock-logic.test.js
import { describe, it, expect } from 'vitest'
import { shouldLockForIdle, STUDIO_IDLE_MS } from './studio-pin-lock-logic'

describe('shouldLockForIdle', () => {
  it('is 5 minutes', () => {
    expect(STUDIO_IDLE_MS).toBe(5 * 60 * 1000)
  })
  it('false when never active', () => {
    expect(shouldLockForIdle(null, 1_000_000)).toBe(false)
  })
  it('false before the idle window elapses', () => {
    const t = 1_000_000
    expect(shouldLockForIdle(t, t + STUDIO_IDLE_MS - 1)).toBe(false)
  })
  it('true once the idle window elapses', () => {
    const t = 1_000_000
    expect(shouldLockForIdle(t, t + STUDIO_IDLE_MS)).toBe(true)
  })
  it('honours a custom window', () => {
    expect(shouldLockForIdle(0, 50, 100)).toBe(false)
    expect(shouldLockForIdle(0, 100, 100)).toBe(true)
  })
})
