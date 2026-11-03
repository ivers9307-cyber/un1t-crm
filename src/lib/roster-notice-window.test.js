// PUBSUMMARY.1 — a change to a published shift is told now only when the
// shift starts within 24 hours; every other one waits for Publish.
import { describe, it, expect } from 'vitest'
import { startsWithinNoticeWindow, NOTICE_NOW_WINDOW_MS } from './roster-notice-window'

const zone = 'Europe/Dublin'
// Mon 2 Nov 2026 10:00 Dublin (winter time, UTC+0).
const nowMs = Date.parse('2026-11-02T10:00:00Z')

describe('startsWithinNoticeWindow', () => {
  it('is a 24-hour window', () => {
    expect(NOTICE_NOW_WINDOW_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('within 24 hours on the studio clock: now', () => {
    expect(startsWithinNoticeWindow({ blockDate: '2026-11-03', startTime: '09:59:00' }, { nowMs, zone })).toBe(true)
    expect(startsWithinNoticeWindow({ blockDate: '2026-11-03', startTime: '10:00' }, { nowMs, zone })).toBe(true)
  })

  it('beyond 24 hours: held for Publish', () => {
    expect(startsWithinNoticeWindow({ blockDate: '2026-11-03', startTime: '10:01:00' }, { nowMs, zone })).toBe(false)
    expect(startsWithinNoticeWindow({ blockDate: '2026-11-09', startTime: '06:00:00' }, { nowMs, zone })).toBe(false)
  })

  it('already started or in the past: now (the senders decide whether it is still worth telling)', () => {
    expect(startsWithinNoticeWindow({ blockDate: '2026-11-02', startTime: '06:00:00' }, { nowMs, zone })).toBe(true)
  })

  it('judged on the studio zone, not UTC', () => {
    // 3 Nov 05:00 in New York is 10:00 UTC: exactly 24h after nowMs.
    expect(startsWithinNoticeWindow({ blockDate: '2026-11-03', startTime: '05:00:00' }, { nowMs, zone: 'America/New_York' })).toBe(true)
    expect(startsWithinNoticeWindow({ blockDate: '2026-11-03', startTime: '05:30:00' }, { nowMs, zone: 'America/New_York' })).toBe(false)
  })

  it('an unreadable date or start reads as now: never held on a guess', () => {
    for (const shift of [{ blockDate: '2026-11-09', startTime: null }, { blockDate: 'soon', startTime: '06:00' }, {}]) {
      expect(startsWithinNoticeWindow(shift, { nowMs, zone })).toBe(true)
    }
  })
})
