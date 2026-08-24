import { describe, it, expect } from 'vitest'
import {
  createUpdateGate,
  CHECK_THROTTLE_MS,
  RELOAD_GRACE_MS,
} from './foreground-update-logic'

const MIN = 60 * 1000

describe('createUpdateGate', () => {
  it('exports a 15-minute throttle and a short reload grace window', () => {
    expect(CHECK_THROTTLE_MS).toBe(15 * MIN)
    expect(RELOAD_GRACE_MS).toBeGreaterThan(0)
    expect(RELOAD_GRACE_MS).toBeLessThanOrEqual(30 * 1000)
  })

  describe('onAppStateChange', () => {
    it('requests a check on the first background→active transition', () => {
      const gate = createUpdateGate()
      expect(gate.onAppStateChange('background', 'active', 1000)).toBe('check')
    })

    it('ignores inactive→active (control-centre / app-switcher flicker)', () => {
      const gate = createUpdateGate()
      expect(gate.onAppStateChange('inactive', 'active', 1000)).toBe('none')
    })

    it('ignores transitions away from active', () => {
      const gate = createUpdateGate()
      expect(gate.onAppStateChange('active', 'background', 1000)).toBe('none')
      expect(gate.onAppStateChange('active', 'inactive', 1000)).toBe('none')
    })

    it('throttles: no second check inside the throttle window', () => {
      const gate = createUpdateGate()
      expect(gate.onAppStateChange('background', 'active', 0)).toBe('check')
      expect(gate.onAppStateChange('background', 'active', 5 * MIN)).toBe('none')
      expect(gate.onAppStateChange('background', 'active', 14 * MIN)).toBe('none')
    })

    it('allows a check again once the throttle window has elapsed', () => {
      const gate = createUpdateGate()
      expect(gate.onAppStateChange('background', 'active', 0)).toBe('check')
      expect(gate.onAppStateChange('background', 'active', 15 * MIN)).toBe('check')
    })

    it('respects a custom throttleMs', () => {
      const gate = createUpdateGate({ throttleMs: 1000 })
      expect(gate.onAppStateChange('background', 'active', 0)).toBe('check')
      expect(gate.onAppStateChange('background', 'active', 500)).toBe('none')
      expect(gate.onAppStateChange('background', 'active', 1000)).toBe('check')
    })

    // RN's iOS willEnterForeground mapping has differed across versions:
    // 0.86 hardcodes it to "background" (so a real foreground reports
    // background→active directly), but older RNs read the live
    // applicationState and emitted background→INACTIVE→active. The gate
    // must fire under BOTH mappings — it keys on "did we pass through
    // 'background' since the last real foreground", never on the previous
    // state's name.
    it('fires on the older-RN sequence background→inactive→active', () => {
      const gate = createUpdateGate()
      expect(gate.onAppStateChange('background', 'inactive', 900)).toBe('none')
      expect(gate.onAppStateChange('inactive', 'active', 1000)).toBe('check')
    })

    it('a full round trip observed from active still fires exactly once', () => {
      const gate = createUpdateGate({ throttleMs: 1000 })
      expect(gate.onAppStateChange('active', 'inactive', 0)).toBe('none')
      expect(gate.onAppStateChange('inactive', 'background', 10)).toBe('none')
      expect(gate.onAppStateChange('background', 'inactive', 5000)).toBe('none')
      expect(gate.onAppStateChange('inactive', 'active', 5010)).toBe('check')
      // The background evidence is consumed by the fire — a flicker straight
      // after must not re-fire even with the throttle elapsed.
      expect(gate.onAppStateChange('active', 'inactive', 9000)).toBe('none')
      expect(gate.onAppStateChange('inactive', 'active', 9010)).toBe('none')
    })
  })

  describe('onUpdateFetched', () => {
    it('reloads when the fetch lands just after foregrounding with no focused input', () => {
      const gate = createUpdateGate()
      gate.onAppStateChange('background', 'active', 0)
      expect(gate.onUpdateFetched(3000, { inputFocused: false })).toBe('reload')
    })

    it('defers when the fetch lands after the grace window (user is mid-task)', () => {
      const gate = createUpdateGate()
      gate.onAppStateChange('background', 'active', 0)
      expect(gate.onUpdateFetched(RELOAD_GRACE_MS + 1, { inputFocused: false })).toBe('defer')
    })

    it('defers when an input is focused, even inside the grace window', () => {
      const gate = createUpdateGate()
      gate.onAppStateChange('background', 'active', 0)
      expect(gate.onUpdateFetched(1000, { inputFocused: true })).toBe('defer')
    })

    it('defers when no foreground transition was ever seen (cold-start safety)', () => {
      const gate = createUpdateGate()
      expect(gate.onUpdateFetched(1000, { inputFocused: false })).toBe('defer')
    })

    it('respects a custom graceMs', () => {
      const gate = createUpdateGate({ graceMs: 500 })
      gate.onAppStateChange('background', 'active', 0)
      expect(gate.onUpdateFetched(400, { inputFocused: false })).toBe('reload')
      const gate2 = createUpdateGate({ graceMs: 500 })
      gate2.onAppStateChange('background', 'active', 0)
      expect(gate2.onUpdateFetched(600, { inputFocused: false })).toBe('defer')
    })
  })

  describe('deferred update → apply on next foreground', () => {
    it('returns reload on the next background→active transition after a defer', () => {
      const gate = createUpdateGate()
      gate.onAppStateChange('background', 'active', 0)
      gate.onUpdateFetched(RELOAD_GRACE_MS + 1, { inputFocused: false })
      expect(gate.onAppStateChange('background', 'active', 5 * MIN)).toBe('reload')
    })

    it('pending reload wins over the throttle (no re-check, immediate reload)', () => {
      const gate = createUpdateGate()
      gate.onAppStateChange('background', 'active', 0)
      gate.onUpdateFetched(RELOAD_GRACE_MS + 1, { inputFocused: false })
      // Well past the throttle window: still a reload, not a fresh check.
      expect(gate.onAppStateChange('background', 'active', 20 * MIN)).toBe('reload')
    })

    it('does not reload on inactive→active flickers while a reload is pending', () => {
      const gate = createUpdateGate()
      gate.onAppStateChange('background', 'active', 0)
      gate.onUpdateFetched(RELOAD_GRACE_MS + 1, { inputFocused: false })
      expect(gate.onAppStateChange('inactive', 'active', 5 * MIN)).toBe('none')
    })

    it('applies a deferred reload on the older-RN sequence background→inactive→active', () => {
      const gate = createUpdateGate()
      gate.onAppStateChange('background', 'active', 0)
      gate.onUpdateFetched(RELOAD_GRACE_MS + 1, { inputFocused: false })
      expect(gate.onAppStateChange('background', 'inactive', 5 * MIN)).toBe('none')
      expect(gate.onAppStateChange('inactive', 'active', 5 * MIN + 10)).toBe('reload')
    })
  })
})
