import { describe, it, expect } from 'vitest'
import {
  resolveScheduledAt,
  bucketLateness,
  minutesLate,
  matchArrivalToShift,
  arrivalToTimeOnly,
} from './staff-attendance.js'

describe('resolveScheduledAt', () => {
  it('Dublin in summer is UTC+1 (BST)', () => {
    // 2026-07-15 06:00 Dublin → 2026-07-15 05:00 UTC
    const utc = resolveScheduledAt('2026-07-15', '06:00:00', 'Europe/Dublin')
    expect(utc.toISOString()).toBe('2026-07-15T05:00:00.000Z')
  })

  it('Dublin in winter is UTC+0 (GMT)', () => {
    const utc = resolveScheduledAt('2026-01-15', '06:00:00', 'Europe/Dublin')
    expect(utc.toISOString()).toBe('2026-01-15T06:00:00.000Z')
  })

  it('handles HH:MM (no seconds)', () => {
    const utc = resolveScheduledAt('2026-01-15', '06:00', 'Europe/Dublin')
    expect(utc.toISOString()).toBe('2026-01-15T06:00:00.000Z')
  })

  it('UTC tz round-trips identity', () => {
    const utc = resolveScheduledAt('2026-05-09', '09:30:00', 'UTC')
    expect(utc.toISOString()).toBe('2026-05-09T09:30:00.000Z')
  })

  it('returns null on missing inputs', () => {
    expect(resolveScheduledAt(null, '06:00', 'Europe/Dublin')).toBeNull()
    expect(resolveScheduledAt('2026-01-15', null, 'Europe/Dublin')).toBeNull()
  })

  it('correctly handles spring-forward day in Dublin', () => {
    // Last Sunday of March 2026 is the 29th. Clocks jump 01:00 → 02:00 GMT.
    // A 06:00 Dublin shift on that day is 05:00 UTC (already on BST).
    const utc = resolveScheduledAt('2026-03-29', '06:00:00', 'Europe/Dublin')
    expect(utc.toISOString()).toBe('2026-03-29T05:00:00.000Z')
  })
})

describe('bucketLateness', () => {
  const sched = '2026-05-09T06:00:00.000Z'
  const schedEnd = '2026-05-09T07:00:00.000Z'

  it('arrival exactly on scheduled = on_time', () => {
    expect(bucketLateness(sched, sched)).toBe('on_time')
  })

  it('arrival 30s after scheduled = on_time (within 60s grace)', () => {
    expect(bucketLateness(sched, '2026-05-09T06:00:30.000Z')).toBe('on_time')
  })

  it('arrival 60s after scheduled = on_time (boundary)', () => {
    expect(bucketLateness(sched, '2026-05-09T06:01:00.000Z')).toBe('on_time')
  })

  it('arrival 61s after scheduled = late', () => {
    expect(bucketLateness(sched, '2026-05-09T06:01:01.000Z')).toBe('late')
  })

  it('arrival 5 min before = on_time', () => {
    expect(bucketLateness(sched, '2026-05-09T05:55:00.000Z')).toBe('on_time')
  })

  it('no arrival, shift in past = no_show', () => {
    expect(bucketLateness(sched, null, {
      scheduledEndAt: schedEnd,
      nowMs: Date.parse('2026-05-09T08:00:00.000Z'),
    })).toBe('no_show')
  })

  it('no arrival, shift still in future/in-progress = pending', () => {
    expect(bucketLateness(sched, null, {
      scheduledEndAt: schedEnd,
      nowMs: Date.parse('2026-05-09T06:30:00.000Z'),
    })).toBe('pending')
  })

  it('honours custom grace', () => {
    expect(bucketLateness(sched, '2026-05-09T06:04:00.000Z', { graceMs: 5 * 60_000 })).toBe('on_time')
    expect(bucketLateness(sched, '2026-05-09T06:06:00.000Z', { graceMs: 5 * 60_000 })).toBe('late')
  })
})

describe('minutesLate', () => {
  it('5 minutes late', () => {
    expect(minutesLate('2026-05-09T06:00:00Z', '2026-05-09T06:05:00Z')).toBe(5)
  })
  it('on time = 0', () => {
    expect(minutesLate('2026-05-09T06:00:00Z', '2026-05-09T06:00:00Z')).toBe(0)
  })
  it('early = negative', () => {
    expect(minutesLate('2026-05-09T06:00:00Z', '2026-05-09T05:55:00Z')).toBe(-5)
  })
  it('null when missing', () => {
    expect(minutesLate(null, '2026-05-09T06:00:00Z')).toBeNull()
    expect(minutesLate('2026-05-09T06:00:00Z', null)).toBeNull()
  })
})

describe('matchArrivalToShift', () => {
  const morning   = { id: 'm', scheduledAt: '2026-05-09T06:00:00Z', scheduledEndAt: '2026-05-09T07:00:00Z' }
  const lunch     = { id: 'l', scheduledAt: '2026-05-09T12:00:00Z', scheduledEndAt: '2026-05-09T13:00:00Z' }
  const evening   = { id: 'e', scheduledAt: '2026-05-09T18:00:00Z', scheduledEndAt: '2026-05-09T19:00:00Z' }

  it('picks the closest shift', () => {
    const r = matchArrivalToShift('2026-05-09T05:55:00Z', [morning, lunch, evening])
    expect(r.shift.id).toBe('m')
    expect(r.deltaMs).toBe(5 * 60_000)
  })

  it('picks lunch over morning when arrival is mid-day', () => {
    const r = matchArrivalToShift('2026-05-09T11:50:00Z', [morning, lunch, evening])
    expect(r.shift.id).toBe('l')
  })

  it('returns null if no shift in window', () => {
    const r = matchArrivalToShift('2026-05-09T03:00:00Z', [morning, lunch], { windowMs: 60_000 })
    expect(r).toBeNull()
  })

  it('skips shifts whose scheduled end is before the arrival', () => {
    // 8am arrival, morning shift ended at 7am — should NOT match morning
    const r = matchArrivalToShift('2026-05-09T08:00:00Z', [morning, lunch])
    expect(r.shift.id).toBe('l')
  })

  it('returns null on empty input', () => {
    expect(matchArrivalToShift('2026-05-09T06:00:00Z', [])).toBeNull()
    expect(matchArrivalToShift('2026-05-09T06:00:00Z', null)).toBeNull()
  })

  it('handles ties by earliest scheduledAt', () => {
    const a = { id: 'a', scheduledAt: '2026-05-09T06:00:00Z' }
    const b = { id: 'b', scheduledAt: '2026-05-09T07:00:00Z' }
    // Arrival exactly halfway between → both are 30 min away
    const r = matchArrivalToShift('2026-05-09T06:30:00Z', [a, b])
    expect(r.shift.id).toBe('a')
  })
})

describe('arrivalToTimeOnly', () => {
  it('formats UTC arrival in Dublin local time (winter)', () => {
    expect(arrivalToTimeOnly('2026-01-09T06:00:00Z', 'Europe/Dublin')).toBe('06:00:00')
  })
  it('formats UTC arrival in Dublin local time (summer = UTC+1)', () => {
    expect(arrivalToTimeOnly('2026-07-09T06:00:00Z', 'Europe/Dublin')).toBe('07:00:00')
  })
  it('returns null on null input', () => {
    expect(arrivalToTimeOnly(null, 'Europe/Dublin')).toBeNull()
  })
})
