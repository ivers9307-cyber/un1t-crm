// src/lib/host-schedule-time.test.js
// HOST-SCHEDULE.1 — Dublin wall-clock <-> UTC for the schedule panel, the
// "next quarter hour" default, the validation window the schedule route
// enforces, and the plain-language copy for a fire-time refusal.
// Everything here runs in the browser too, so it is Intl-only.

import { describe, it, expect } from 'vitest'
import {
  dublinLocalToIso, isoToDublinInputs, nextQuarterHour, dublinScheduleLabel, QUARTER_MS, CLICK_SLACK_MS,
  validateScheduledFor, scheduleErrorCopy, SCHEDULE_ERROR_COPY, TIME_OPTIONS,
  MIN_LEAD_MS, MAX_LEAD_MS,
} from './host-schedule-time.js'

describe('dublinLocalToIso', () => {
  it('converts an IST (summer) wall clock to UTC', () => {
    expect(dublinLocalToIso('2026-09-09', '09:00')).toBe('2026-09-09T08:00:00.000Z')
  })
  it('converts a GMT (winter) wall clock to UTC', () => {
    expect(dublinLocalToIso('2026-01-15', '09:00')).toBe('2026-01-15T09:00:00.000Z')
  })
  it('rejects malformed inputs with null', () => {
    expect(dublinLocalToIso('', '09:00')).toBe(null)
    expect(dublinLocalToIso('2026-09-09', '9am')).toBe(null)
    expect(dublinLocalToIso('2026-13-40', '09:00')).toBe(null)
  })

  // Ireland's clocks spring forward 01:00 -> 02:00 on 29 Mar 2026 (01:xx
  // Dublin doesn't exist that day) and fall back 02:00 -> 01:00 on
  // 25 Oct 2026 (01:xx Dublin happens twice).
  it('converts a wall clock just after the spring-forward gap', () => {
    expect(dublinLocalToIso('2026-03-29', '02:30')).toBe('2026-03-29T01:30:00.000Z')
  })
  it('rejects a wall clock that falls inside the spring-forward gap', () => {
    expect(dublinLocalToIso('2026-03-29', '01:30')).toBe(null)
  })
  it('resolves an ambiguous fall-back wall clock to the later (GMT) occurrence', () => {
    expect(dublinLocalToIso('2026-10-25', '01:30')).toBe('2026-10-25T01:30:00.000Z')
  })
  it('converts a wall clock just before the fall-back ambiguity', () => {
    expect(dublinLocalToIso('2026-10-25', '00:30')).toBe('2026-10-24T23:30:00.000Z')
  })

  it('round-trips every quarter hour on ordinary days either side of both DST transitions', () => {
    for (const date of ['2026-03-28', '2026-03-30', '2026-10-24', '2026-10-26']) {
      for (const time of TIME_OPTIONS) {
        expect(isoToDublinInputs(dublinLocalToIso(date, time))).toEqual({ date, time })
      }
    }
  })
})

describe('isoToDublinInputs', () => {
  it('round-trips a UTC instant back to Dublin date + time', () => {
    expect(isoToDublinInputs('2026-09-09T08:00:00.000Z')).toEqual({ date: '2026-09-09', time: '09:00' })
    expect(isoToDublinInputs('2026-01-15T09:00:00.000Z')).toEqual({ date: '2026-01-15', time: '09:00' })
  })
  it('returns null for garbage', () => {
    expect(isoToDublinInputs('nope')).toBe(null)
  })
  it('returns null for null, undefined, and empty string (not the epoch)', () => {
    expect(isoToDublinInputs(null)).toBe(null)
    expect(isoToDublinInputs(undefined)).toBe(null)
    expect(isoToDublinInputs('')).toBe(null)
  })
})

describe('nextQuarterHour', () => {
  it('is the first quarter hour at least 15 minutes out, in Dublin time', () => {
    // 10:03Z + 15 min = 10:18Z -> 10:30Z -> 11:30 Dublin (IST)
    expect(nextQuarterHour(Date.parse('2026-09-07T10:03:00Z'))).toEqual({ date: '2026-09-07', time: '11:30' })
  })
  it('steps to the NEXT quarter, not the one it lands on, when the lead already is one', () => {
    // 10:15Z + 15 = 10:30Z exactly -> zero margin against validateScheduledFor,
    // so this must roll on to 10:45Z (30 min lead) instead of stopping at 10:30Z.
    expect(nextQuarterHour(Date.parse('2026-09-07T10:15:00Z'))).toEqual({ date: '2026-09-07', time: '11:45' })
  })
  it('rolls over the Dublin day', () => {
    // 23:50Z 7 Sep + 15 lead = 00:05Z 8 Sep, not itself quarter-aligned, so
    // the next-quarter-strictly-after step lands on the same boundary as a
    // plain ceil would: 00:15Z -> 01:15 Dublin (IST) 8 Sep.
    expect(nextQuarterHour(Date.parse('2026-09-07T23:50:00Z'))).toEqual({ date: '2026-09-08', time: '01:15' })
  })

  it('property: the default still validates after the host takes CLICK_SLACK_MS to click, for every second of a quarter-hour cycle', () => {
    const start = Date.parse('2026-09-07T10:00:00Z')
    for (let s = 0; s <= QUARTER_MS / 1000; s += 1) {
      const now = start + s * 1000
      const d = nextQuarterHour(now)
      const iso = dublinLocalToIso(d.date, d.time)
      const res = validateScheduledFor(iso, now + CLICK_SLACK_MS)
      expect(res.ok, `now=${new Date(now).toISOString()} default=${iso}`).toBe(true)
      expect(Date.parse(iso) - now).toBeLessThan(MIN_LEAD_MS + CLICK_SLACK_MS + QUARTER_MS)
    }
  })
})

describe('dublinScheduleLabel', () => {
  it('reads "Wed 9 Sep, 09:00" for a summer instant', () => {
    expect(dublinScheduleLabel('2026-09-09T08:00:00.000Z')).toBe('Wed 9 Sep, 09:00')
  })
  it('reads a winter instant without the DST shift', () => {
    expect(dublinScheduleLabel('2026-01-15T09:00:00.000Z')).toBe('Thu 15 Jan, 09:00')
  })
  it('is empty for null or garbage, never "Invalid Date"', () => {
    expect(dublinScheduleLabel(null)).toBe('')
    expect(dublinScheduleLabel('nope')).toBe('')
  })
  it('is empty for undefined and empty string too', () => {
    expect(dublinScheduleLabel(undefined)).toBe('')
    expect(dublinScheduleLabel('')).toBe('')
  })
})

describe('validateScheduledFor', () => {
  const now = Date.parse('2026-09-07T10:00:00Z')
  it('accepts a time inside the window and normalises it to ISO', () => {
    expect(validateScheduledFor('2026-09-07T11:20:00+01:00', now)).toEqual({ ok: true, iso: '2026-09-07T10:20:00.000Z' })
  })
  it('rejects a non-date', () => {
    expect(validateScheduledFor('tomorrow', now)).toEqual({ ok: false, error: 'Pick a date and time.' })
    expect(validateScheduledFor(undefined, now).ok).toBe(false)
  })
  it('rejects null and a bare number, not just undefined', () => {
    expect(validateScheduledFor(null, now)).toEqual({ ok: false, error: 'Pick a date and time.' })
    expect(validateScheduledFor(123, now)).toEqual({ ok: false, error: 'Pick a date and time.' })
  })
  it('rejects anything under 15 minutes ahead, including the past', () => {
    expect(validateScheduledFor('2026-09-07T10:10:00Z', now)).toEqual({ ok: false, error: 'Pick a time at least 15 minutes from now.' })
    expect(validateScheduledFor('2026-09-07T09:00:00Z', now).ok).toBe(false)
  })
  it('accepts exactly 15 minutes ahead and rejects anything past 90 days', () => {
    expect(validateScheduledFor(new Date(now + MIN_LEAD_MS).toISOString(), now).ok).toBe(true)
    expect(validateScheduledFor(new Date(now + MAX_LEAD_MS + 60_000).toISOString(), now)).toEqual({ ok: false, error: 'Pick a time within the next 90 days.' })
  })
})

describe('scheduleErrorCopy', () => {
  it('has plain copy for every reason the sweeper can write, with no em-dashes', () => {
    for (const code of ['sender_not_verified', 'no_stream', 'daily_cap', 'no_recipients', 'launch_failed']) {
      expect(SCHEDULE_ERROR_COPY[code]).toBeTruthy()
      expect(SCHEDULE_ERROR_COPY[code]).not.toContain('—')
    }
  })
  it('falls back to the generic line for an unknown code', () => {
    expect(scheduleErrorCopy('something_new')).toBe(SCHEDULE_ERROR_COPY.launch_failed)
  })
  it('falls back for a code that only matches through the prototype chain', () => {
    // A naive `SCHEDULE_ERROR_COPY[code] || fallback` resolves 'constructor'
    // to Object.prototype.constructor (a function) instead of falling back.
    expect(scheduleErrorCopy('constructor')).toBe(SCHEDULE_ERROR_COPY.launch_failed)
    expect(scheduleErrorCopy('__proto__')).toBe(SCHEDULE_ERROR_COPY.launch_failed)
  })
})

describe('TIME_OPTIONS', () => {
  it('is every quarter hour of the day, zero-padded', () => {
    expect(TIME_OPTIONS).toHaveLength(96)
    expect(TIME_OPTIONS[0]).toBe('00:00')
    expect(TIME_OPTIONS[1]).toBe('00:15')
    expect(TIME_OPTIONS[95]).toBe('23:45')
  })
})
