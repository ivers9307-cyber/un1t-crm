import { describe, it, expect } from 'vitest'
import { safetyTimerEndMs, withSafetyTimerNotice } from './safety-notice'

const NOW = Date.parse('2026-07-06T12:00:00.000Z') // 13:00 Dublin, 08:00 New York
const iso = (ms) => new Date(ms).toISOString()
const H = 3600_000

describe('safetyTimerEndMs (SHELLYTIMERS.6)', () => {
  it('takes the LATEST future cap_at on an on-stamp, or timer_until', () => {
    expect(safetyTimerEndMs([
      { last_applied: { action: 'on', cap_at: iso(NOW + H) } },
      { last_state: { timer_until: iso(NOW + 2 * H) } },
      { last_applied: { action: 'on', cap_at: iso(NOW + 30 * 60_000) } },
    ], NOW)).toBe(NOW + 2 * H)
  })
  it('ignores past times, off stamps, junk and absent fields', () => {
    expect(safetyTimerEndMs([
      { last_applied: { action: 'on', cap_at: iso(NOW - 1) } },
      { last_applied: { action: 'off', cap_at: iso(NOW + H) } },
      { last_applied: { action: 'on', cap_at: 'soon' } },
      { last_applied: { action: 'on' } },
      { last_state: { timer_until: 42 } },
      { last_applied: 'x', last_state: null },
      null,
    ], NOW)).toBe(null)
    expect(safetyTimerEndMs(null, NOW)).toBe(null)
  })
})

describe('withSafetyTimerNotice (SHELLYTIMERS.6)', () => {
  const devs = [{ last_applied: { action: 'on', cap_at: iso(NOW + 9.5 * H) } }] // 21:30Z
  it('appends the time in the STUDIO zone', () => {
    expect(withSafetyTimerNotice('Group removed. Its devices stay as they are until you switch them.', devs, NOW, 'Europe/Dublin'))
      .toBe('Group removed. Its devices stay as they are until you switch them. A light the schedule switched on still switches itself off by 22:30 (safety timer).')
    expect(withSafetyTimerNotice('Schedule switched off', devs, NOW, 'America/New_York', 'It'))
      .toBe('Schedule switched off. It still switches itself off by 17:30 (safety timer).')
  })
  it('leaves the text alone with no pending timer', () => {
    expect(withSafetyTimerNotice('X', [], NOW, 'Europe/Dublin')).toBe('X')
    expect(withSafetyTimerNotice('X', [{ last_applied: { action: 'on', cap_at: iso(NOW - H) } }], NOW, 'Europe/Dublin')).toBe('X')
  })
})
