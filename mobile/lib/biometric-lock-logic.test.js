import { describe, it, expect } from 'vitest'
import { shouldRelock, biometricLabel, RELOCK_GRACE_MS } from './biometric-lock-logic'

describe('RELOCK_GRACE_MS', () => {
  it('is 5 minutes', () => { expect(RELOCK_GRACE_MS).toBe(5 * 60 * 1000) })
})

describe('shouldRelock', () => {
  const now = 10_000_000
  it('false when never backgrounded', () => {
    expect(shouldRelock(null, now, RELOCK_GRACE_MS)).toBe(false)
    expect(shouldRelock(undefined, now, RELOCK_GRACE_MS)).toBe(false)
  })
  it('false within the grace window', () => {
    expect(shouldRelock(now - (RELOCK_GRACE_MS - 1), now, RELOCK_GRACE_MS)).toBe(false)
  })
  it('true at or past the grace window', () => {
    expect(shouldRelock(now - RELOCK_GRACE_MS, now, RELOCK_GRACE_MS)).toBe(true)
    expect(shouldRelock(now - (RELOCK_GRACE_MS + 5000), now, RELOCK_GRACE_MS)).toBe(true)
  })
})

describe('biometricLabel', () => {
  it('Face ID when FACIAL_RECOGNITION (2) present (wins over fingerprint)', () => {
    expect(biometricLabel([2])).toBe('Face ID')
    expect(biometricLabel([1, 2])).toBe('Face ID')
  })
  it('Touch ID when only FINGERPRINT (1)', () => {
    expect(biometricLabel([1])).toBe('Touch ID')
  })
  it('falls back to "biometrics"', () => {
    expect(biometricLabel([])).toBe('biometrics')
    expect(biometricLabel([3])).toBe('biometrics')
    expect(biometricLabel(null)).toBe('biometrics')
  })
})
