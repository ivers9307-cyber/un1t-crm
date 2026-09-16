import { describe, it, expect } from 'vitest'
import {
  resolveScheduledAt,
  bucketLateness,
  minutesLate,
  arrivalToTimeOnly,
  decideGeofenceStamp,
  inferContinuousArrivals,
  GEOFENCE_EARLY_WINDOW_MS,
  GEOFENCE_REENTRY_GAP_MS,
} from './staff-attendance'

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

// Dublin summer wall clock on the review date.
const at = (hhmm) => new Date(`2026-09-16T${hhmm}:00+01:00`)
const shift = (id, start, end, arrived = null) => ({
  id,
  scheduledAt: at(start),
  scheduledEndAt: at(end),
  arrivedAt: arrived ? at(arrived) : null,
})

describe('decideGeofenceStamp', () => {
  it('uses a 45-minute early window and a 60-minute re-entry gap', () => {
    expect(GEOFENCE_EARLY_WINDOW_MS).toBe(45 * 60_000)
    expect(GEOFENCE_REENTRY_GAP_MS).toBe(60 * 60_000)
  })

  it('stamps the nearest shift with no arrival inside the early window', () => {
    const d = decideGeofenceStamp(at('07:40'), [shift('a', '08:00', '09:00'), shift('b', '09:15', '10:30')])
    expect(d.kind).toBe('stamp')
    expect(d.shift.id).toBe('a')
  })

  it('stamps a late arrival while the shift is still running', () => {
    const d = decideGeofenceStamp(at('08:20'), [shift('a', '08:00', '09:00')])
    expect(d).toMatchObject({ kind: 'stamp', shift: { id: 'a' } })
  })

  it('matches nothing more than 45 minutes before a start', () => {
    expect(decideGeofenceStamp(at('07:14'), [shift('a', '08:00', '09:00')])).toEqual({ kind: 'none', shift: null })
  })

  it('matches nothing after a shift has ended', () => {
    expect(decideGeofenceStamp(at('09:10'), [shift('a', '08:00', '09:00')])).toEqual({ kind: 'none', shift: null })
  })

  it('16 Sep regression: a duplicate ping never moves on to the next shift', () => {
    // The first ping already stamped the 08:00 shift at 07:39.
    const shifts = [shift('a', '08:00', '09:00', '07:39'), shift('b', '09:15', '10:30'), shift('c', '10:45', '12:00')]
    const d = decideGeofenceStamp(new Date('2026-09-16T07:39:02+01:00'), shifts)
    expect(d).toMatchObject({ kind: 'reentry', shift: { id: 'a' } })
  })

  it('treats walking back in soon after a shift ended as a re-entry', () => {
    const shifts = [shift('a', '08:00', '09:00', '07:39'), shift('b', '09:15', '10:30'), shift('c', '10:45', '12:00')]
    expect(decideGeofenceStamp(at('09:55'), shifts)).toMatchObject({ kind: 'reentry', shift: { id: 'a' } })
  })

  it('an evening arrival after a morning shift is a new arrival', () => {
    const shifts = [shift('m', '06:00', '08:00', '05:50'), shift('e', '17:45', '20:30')]
    expect(decideGeofenceStamp(at('17:30'), shifts)).toMatchObject({ kind: 'stamp', shift: { id: 'e' } })
  })

  it('reports already when the nearest shift has a LATER recorded arrival', () => {
    const d = decideGeofenceStamp(at('07:58'), [shift('a', '08:00', '09:00', '08:05')])
    expect(d).toMatchObject({ kind: 'already', shift: { id: 'a' } })
  })

  it('returns none for bad input', () => {
    expect(decideGeofenceStamp('nope', [shift('a', '08:00', '09:00')])).toEqual({ kind: 'none', shift: null })
    expect(decideGeofenceStamp(at('08:00'), null)).toEqual({ kind: 'none', shift: null })
  })

  it('prefers a shift that is already running over one that has not started yet', () => {
    const d = decideGeofenceStamp(at('08:40'), [shift('a', '08:00', '09:00'), shift('b', '09:00', '10:00')])
    expect(d).toMatchObject({ kind: 'stamp', shift: { id: 'a' } })
  })

  it('prefers a running shift over a not-yet-started one even when the running shift started long ago', () => {
    const d = decideGeofenceStamp(at('09:40'), [shift('a', '08:00', '10:00'), shift('b', '10:15', '11:00')])
    expect(d).toMatchObject({ kind: 'stamp', shift: { id: 'a' } })
  })

  it('stamps exactly at the 45-minute early boundary', () => {
    const d = decideGeofenceStamp(at('07:15'), [shift('a', '08:00', '09:00')])
    expect(d).toMatchObject({ kind: 'stamp', shift: { id: 'a' } })
  })

  it('prefers a running shift over a future one whose start is closer to the ping', () => {
    const d = decideGeofenceStamp(at('09:50'), [shift('a', '08:00', '10:00'), shift('b', '09:55', '11:00')])
    expect(d).toMatchObject({ kind: 'stamp', shift: { id: 'a' } })
  })

  it('re-entry picks the on-site shift with the latest recorded arrival, not array order', () => {
    const shifts = [shift('a', '08:00', '09:00', '07:39'), shift('b', '09:15', '10:30', '09:10')]
    const d = decideGeofenceStamp(at('09:30'), shifts)
    expect(d).toMatchObject({ kind: 'reentry', shift: { id: 'b' } })
  })

  it('a re-entry-window ping does not hide a later shift the coach has not started yet (gap > reentry gap)', () => {
    // A 09:00-10:00 arrived 08:55; ping at 10:50 is within A's re-entry
    // window (end 10:00 + 60 min = 11:00), but B starts at 11:30 — 90
    // minutes after A ended, well past the 60-minute re-entry gap. B is
    // eligible (10:50 is inside its 45-minute early window) and unstamped,
    // so the ping must stamp B, not read as a re-entry of A.
    const shifts = [shift('a', '09:00', '10:00', '08:55'), shift('b', '11:30', '12:30')]
    const d = decideGeofenceStamp(at('10:50'), shifts)
    expect(d).toMatchObject({ kind: 'stamp', shift: { id: 'b' } })
  })

  it('a re-entry-window ping still reads as a re-entry when the next shift is inside the gap', () => {
    // Same as above but B starts at 10:45 — only 45 minutes after A ends,
    // inside the 60-minute re-entry gap. Still a re-entry of A.
    const shifts = [shift('a', '09:00', '10:00', '08:55'), shift('b', '10:45', '11:30')]
    const d = decideGeofenceStamp(at('10:30'), shifts)
    expect(d).toMatchObject({ kind: 'reentry', shift: { id: 'a' } })
  })
})

describe('inferContinuousArrivals', () => {
  const row = (id, profileId, start, end, arrival = null) => ({
    id, profileId, blockDate: '2026-09-16',
    scheduledAt: at(start), scheduledEndAt: at(end), arrivalAt: arrival ? at(arrival) : null,
  })

  it('carries an arrival onto back-to-back shifts, keeps input order, and stops at a long gap or another coach', () => {
    const input = [
      row('e', 'p1', '17:45', '20:30'),
      row('c', 'p1', '10:45', '12:00'),
      row('x', 'p2', '09:15', '10:30'),
      row('a', 'p1', '08:00', '09:00', '07:39'),
      row('b', 'p1', '09:15', '10:30'),
    ]
    const out = inferContinuousArrivals(input)
    expect(out.map((r) => r.id)).toEqual(['e', 'c', 'x', 'a', 'b'])
    const byId = Object.fromEntries(out.map((r) => [r.id, r]))
    expect(byId.a).toMatchObject({ arrivalInferred: false })
    expect(byId.a.arrivalAt).toEqual(at('07:39'))
    expect(byId.b).toMatchObject({ arrivalInferred: true })
    expect(byId.b.arrivalAt).toEqual(at('07:39'))
    expect(byId.c).toMatchObject({ arrivalInferred: true })
    expect(byId.e).toMatchObject({ arrivalAt: null, arrivalInferred: false })
    expect(byId.x).toMatchObject({ arrivalAt: null, arrivalInferred: false })
  })

  it('never overwrites a recorded arrival', () => {
    const out = inferContinuousArrivals([row('a', 'p1', '08:00', '09:00', '07:39'), row('b', 'p1', '09:15', '10:30', '09:20')])
    expect(out[1]).toMatchObject({ arrivalInferred: false })
    expect(out[1].arrivalAt).toEqual(at('09:20'))
  })

  it('an inferred arrival reads as on time for the later shift', () => {
    const out = inferContinuousArrivals([row('a', 'p1', '08:00', '09:00', '07:39'), row('b', 'p1', '09:15', '10:30')])
    expect(bucketLateness(out[1].scheduledAt, out[1].arrivalAt)).toBe('on_time')
  })

  it('tolerates null input', () => {
    expect(inferContinuousArrivals(null)).toEqual([])
  })

  it('does not chain rows that share no profileId (both null)', () => {
    const input = [
      { id: 'a', profileId: null, blockDate: '2026-09-16', scheduledAt: at('08:00'), scheduledEndAt: at('09:00'), arrivalAt: at('07:39') },
      { id: 'b', profileId: null, blockDate: '2026-09-16', scheduledAt: at('09:15'), scheduledEndAt: at('10:30'), arrivalAt: null },
    ]
    const out = inferContinuousArrivals(input)
    const byId = Object.fromEntries(out.map((r) => [r.id, r]))
    expect(byId.b).toMatchObject({ arrivalAt: null, arrivalInferred: false })
  })

  it('a row with an invalid scheduledAt keeps arrivalAt null and does not throw', () => {
    const input = [
      row('a', 'p1', '08:00', '09:00', '07:39'),
      { id: 'b', profileId: 'p1', blockDate: '2026-09-16', scheduledAt: new Date('not-a-date'), scheduledEndAt: at('10:30'), arrivalAt: null },
    ]
    expect(() => inferContinuousArrivals(input)).not.toThrow()
    const byId = Object.fromEntries(inferContinuousArrivals(input).map((r) => [r.id, r]))
    expect(byId.b).toMatchObject({ arrivalAt: null, arrivalInferred: false })
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
