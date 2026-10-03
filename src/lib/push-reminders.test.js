// NOTIF.1 — unit tests for the push reminder time helpers.
//
// Tested across multiple host TZ assumptions: the helper must work
// the same when the cron runs in a Vercel container (UTC) or a dev
// laptop in Dublin/LA/Tokyo. The helper is pure JS Intl, so this
// should be host-independent — but the previous roster-summary
// flakiness on TZ proved we need the regression coverage.

import { describe, it, expect } from 'vitest'
import { localToUtc, formatLocalTime, inLeadWindow, isLastFireTick } from './push-reminders'

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

// SHIFTREMIND.1 — localToUtc now reuses one Intl formatter per timezone. The
// tolerance it always had must survive that: an invalid IANA string returns
// null (the caller skips that entity), it never throws into the task or
// booking arm, and a bad zone is never cached or allowed to poison a good one.
describe('localToUtc — invalid timezone tolerance (cached-formatter path)', () => {
  it('returns null, never throws, every time it is asked', () => {
    for (let i = 0; i < 3; i++) {
      expect(() => localToUtc('2026-09-22', '06:00', 'Not/AZone')).not.toThrow()
      expect(localToUtc('2026-09-22', '06:00', 'Not/AZone')).toBeNull()
      expect(localToUtc('2026-09-22', '06:00', '')).toBeNull()
    }
  })

  it('a valid zone still converts correctly before and after a bad one was asked for', () => {
    expect(localToUtc('2026-09-22', '06:00', 'Europe/Dublin').toISOString()).toBe('2026-09-22T05:00:00.000Z')
    localToUtc('2026-09-22', '06:00', 'Not/AZone')
    expect(localToUtc('2026-09-22', '06:00', 'Europe/Dublin').toISOString()).toBe('2026-09-22T05:00:00.000Z')
    expect(localToUtc('2026-12-15', '14:00', 'Europe/Dublin').toISOString()).toBe('2026-12-15T14:00:00.000Z')
  })
})

// CRONREADERR.1 — the push-reminder cron fires (entity, recipient, lead) while
// delta = minutesAway - lead is inside [-15, +5], on a */5 cron. When its
// "already sent?" read fails, it holds the reminder while a later tick can
// still fire it, and sends unchecked only on the last tick that can. The next
// tick is tickMin later plus up to jitterMin (3.5) of Vercel lateness.
describe('isLastFireTick', () => {
  it('early and on-time ticks are not the last chance', () => {
    expect(isLastFireTick(65, 60)).toBe(false) // delta +5, the early edge
    expect(isLastFireTick(60, 60)).toBe(false) // delta 0
    expect(isLastFireTick(55, 60)).toBe(false) // delta -5
  })

  it('the boundary: a later tick (delta - 8.5) still reaches -15, so delta -6.5 holds and just past it is the last chance', () => {
    expect(isLastFireTick(53.5, 60)).toBe(false) // delta -6.5 → next -15, still inside
    expect(isLastFireTick(53.4, 60)).toBe(true)  // delta -6.6 → next -15.1, outside
    expect(isLastFireTick(47, 60)).toBe(true)
    expect(isLastFireTick(45, 60)).toBe(true)    // delta -15, the late edge
  })

  it('an unreadable input is treated as the last chance (send rather than risk a loss)', () => {
    expect(isLastFireTick(Number.NaN, 60)).toBe(true)
    expect(isLastFireTick(60, undefined)).toBe(true)
  })

  it('honours the cadence and window it is given', () => {
    expect(isLastFireTick(50.5, 60, { tickMin: 2 })).toBe(false) // -9.5 - 5.5 = -15
    expect(isLastFireTick(50.4, 60, { tickMin: 2 })).toBe(true)  // -9.6 - 5.5 = -15.1
    expect(isLastFireTick(40, 60, { lateWindowMin: 30 })).toBe(false) // -20 - 8.5 = -28.5
    expect(isLastFireTick(51, 60, { jitterMin: 1 })).toBe(false)  // -9 - 6 = -15
    expect(isLastFireTick(50.9, 60, { jitterMin: 1 })).toBe(true) // -9.1 - 6 = -15.1
  })

  it('agrees with inLeadWindow: whenever it says "not last", the next tick is still inside the window', () => {
    const now = Date.parse('2026-10-06T09:00:00.000Z')
    for (let delta = 5; delta >= -15; delta -= 0.25) {
      const minutesAway = 60 + delta
      if (isLastFireTick(minutesAway, 60)) continue
      const due = new Date(now + minutesAway * 60_000).toISOString()
      const nextTickMs = now + (5 + 3.5) * 60_000 // tick + jitter
      expect(inLeadWindow(due, nextTickMs, 60, 5, 15)).toBe(true)
    }
  })
})
