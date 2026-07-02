// NOTIF.1 — unit tests for the push reminder time helpers.
//
// Tested across multiple host TZ assumptions: the helper must work
// the same when the cron runs in a Vercel container (UTC) or a dev
// laptop in Dublin/LA/Tokyo. The helper is pure JS Intl, so this
// should be host-independent — but the previous roster-summary
// flakiness on TZ proved we need the regression coverage.

import { describe, it, expect } from 'vitest'
import { localToUtc, formatLocalTime, inLeadWindow } from './push-reminders'

describe('localToUtc', () => {
  it('Dublin in DST (BST/IST, UTC+1) → subtracts 1 hour', () => {
    // 2026-06-15 14:00 Dublin = 13:00 UTC (Ireland is on IST in summer).
    const out = localToUtc('2026-06-15', '14:00:00', 'Europe/Dublin')
    expect(out.toISOString()).toBe('2026-06-15T13:00:00.000Z')
  })

  it('Dublin in winter (UTC+0) → no shift', () => {
    const out = localToUtc('2026-12-15', '14:00:00', 'Europe/Dublin')
    expect(out.toISOString()).toBe('2026-12-15T14:00:00.000Z')
  })

  it('handles HH:MM without seconds', () => {
    const out = localToUtc('2026-06-15', '14:00', 'Europe/Dublin')
    expect(out.toISOString()).toBe('2026-06-15T13:00:00.000Z')
  })

  it('Los Angeles (PDT, UTC-7) → adds 7 hours', () => {
    const out = localToUtc('2026-06-15', '09:00:00', 'America/Los_Angeles')
    expect(out.toISOString()).toBe('2026-06-15T16:00:00.000Z')
  })

  it('Tokyo (JST, UTC+9, no DST) → subtracts 9 hours', () => {
    const out = localToUtc('2026-06-15', '09:00:00', 'Asia/Tokyo')
    expect(out.toISOString()).toBe('2026-06-15T00:00:00.000Z')
  })

  it('returns null on malformed input rather than throwing', () => {
    expect(localToUtc('not-a-date', '14:00', 'Europe/Dublin')).toBeNull()
  })

  it('Dublin DST autumn-back transition day (Oct 25 2026, 03:00 local)', () => {
    // After the autumn-back, Dublin is UTC+0. 03:00 Dublin = 03:00 UTC.
    const out = localToUtc('2026-10-26', '03:00:00', 'Europe/Dublin')
    expect(out.toISOString()).toBe('2026-10-26T03:00:00.000Z')
  })
})

describe('formatLocalTime', () => {
  it('formats morning times as am', () => {
    expect(formatLocalTime('09:30:00')).toBe('9:30am')
  })

  it('formats afternoon times as pm with hour wrap', () => {
    expect(formatLocalTime('14:30:00')).toBe('2:30pm')
  })

  it('treats noon as 12pm', () => {
    expect(formatLocalTime('12:00:00')).toBe('12:00pm')
  })

  it('treats midnight as 12am', () => {
    expect(formatLocalTime('00:00:00')).toBe('12:00am')
  })

  it('handles HH:MM without seconds', () => {
    expect(formatLocalTime('14:30')).toBe('2:30pm')
  })

  it('returns empty string on null/undefined', () => {
    expect(formatLocalTime(null)).toBe('')
    expect(formatLocalTime(undefined)).toBe('')
  })
})

describe('inLeadWindow', () => {
  // Fixed "now" for deterministic windows.
  const now = new Date('2026-06-15T12:00:00.000Z').getTime()

  it('1h lead: 1h exactly from now → in window', () => {
    const due = new Date(now + 60 * 60 * 1000).toISOString()
    expect(inLeadWindow(due, now, 60)).toBe(true)
  })

  it('1h lead: 1h + 4min from now → in window (±5min default)', () => {
    const due = new Date(now + 64 * 60 * 1000).toISOString()
    expect(inLeadWindow(due, now, 60)).toBe(true)
  })

  it('1h lead: 1h + 6min from now → out of window', () => {
    const due = new Date(now + 66 * 60 * 1000).toISOString()
    expect(inLeadWindow(due, now, 60)).toBe(false)
  })

  it('24h lead: exactly 24h from now → in window', () => {
    const due = new Date(now + 24 * 3600 * 1000).toISOString()
    expect(inLeadWindow(due, now, 1440)).toBe(true)
  })

  it('24h lead: 23h54m from now → out of window', () => {
    const due = new Date(now + (24 * 60 - 6) * 60 * 1000).toISOString()
    expect(inLeadWindow(due, now, 1440)).toBe(false)
  })

  it('respects custom windowMin', () => {
    const due = new Date(now + 70 * 60 * 1000).toISOString()
    expect(inLeadWindow(due, now, 60, 5)).toBe(false)
    expect(inLeadWindow(due, now, 60, 15)).toBe(true)
  })

  describe('asymmetric late window (missed-cron-tick catch-up)', () => {
    it('defaults to symmetric when lateWindowMin is omitted', () => {
      // 1h lead, due 54min away = running 6 min late → out with default ±5.
      const due = new Date(now + 54 * 60 * 1000).toISOString()
      expect(inLeadWindow(due, now, 60, 5)).toBe(false)
    })

    it('fires LATE inside lateWindowMin (due 46min away on a 60min lead = 14 min late)', () => {
      const due = new Date(now + 46 * 60 * 1000).toISOString()
      expect(inLeadWindow(due, now, 60, 5, 15)).toBe(true)
    })

    it('fires at the late boundary exactly (15 min late)', () => {
      const due = new Date(now + 45 * 60 * 1000).toISOString()
      expect(inLeadWindow(due, now, 60, 5, 15)).toBe(true)
    })

    it('stops matching past the late boundary (16 min late)', () => {
      const due = new Date(now + 44 * 60 * 1000).toISOString()
      expect(inLeadWindow(due, now, 60, 5, 15)).toBe(false)
    })

    it('the EARLY side stays capped at windowMin (does not widen with lateWindowMin)', () => {
      const due = new Date(now + 66 * 60 * 1000).toISOString() // 6 min early
      expect(inLeadWindow(due, now, 60, 5, 15)).toBe(false)
    })
  })
})
