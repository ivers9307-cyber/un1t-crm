import { describe, it, expect } from 'vitest'
import { describePinOutcome, bareHost, PIN_OUTCOME_META } from './studio-pin-outcomes.js'

describe('describePinOutcome', () => {
  it('maps every outcome the pin-login route can write', () => {
    // Lock-step with the outcomes logged in
    // src/app/api/auth/pin-login/route.js. If a new outcome is added
    // there, add it here + to PIN_OUTCOME_META.
    for (const o of ['success', 'wrong_pin', 'untrusted_ip', 'unknown_device', 'device_locked']) {
      expect(PIN_OUTCOME_META[o]).toBeDefined()
      expect(describePinOutcome(o).label).toBeTruthy()
    }
  })

  it('flags untrusted_ip as the actionable one (add to trusted list)', () => {
    expect(describePinOutcome('untrusted_ip').actionable).toBe('trusted_ip')
    expect(describePinOutcome('wrong_pin').actionable).toBeUndefined()
  })

  it('gives success/warn/error tones to the right buckets', () => {
    expect(describePinOutcome('success').tone).toBe('success')
    expect(describePinOutcome('wrong_pin').tone).toBe('warn')
    expect(describePinOutcome('untrusted_ip').tone).toBe('error')
    expect(describePinOutcome('unknown_device').tone).toBe('error')
  })

  it('falls back to the raw value with a muted tone for unknown outcomes', () => {
    expect(describePinOutcome('some_new_gate')).toEqual({ label: 'some_new_gate', tone: 'muted' })
    expect(describePinOutcome(null)).toEqual({ label: 'Unknown', tone: 'muted' })
    expect(describePinOutcome(undefined)).toEqual({ label: 'Unknown', tone: 'muted' })
  })
})

describe('bareHost', () => {
  it('passes through a bare host unchanged', () => {
    expect(bareHost('89.100.70.214')).toBe('89.100.70.214')
  })

  it('strips an implicit /32 or /128 so it drops into the trusted-IP form', () => {
    expect(bareHost('89.100.70.214/32')).toBe('89.100.70.214')
    expect(bareHost('2001:db8::1/128')).toBe('2001:db8::1')
  })

  it('leaves a real subnet mask alone', () => {
    expect(bareHost('89.100.70.0/24')).toBe('89.100.70.0/24')
  })

  it('returns null for empty / non-string input', () => {
    expect(bareHost('')).toBeNull()
    expect(bareHost(null)).toBeNull()
    expect(bareHost(undefined)).toBeNull()
  })
})
