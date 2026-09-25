// WORKTIME.1 — working-time advisories for employees: 11 hours between working
// days, 48 hours in a Monday-to-Sunday week, every studio of the organisation.
// Pure: no clock, no database. Run under TZ=Europe/Dublin AND a US zone; the
// rules must not move with the host.

import { describe, it, expect } from 'vitest'
import {
  MIN_REST_HOURS, MAX_WEEK_HOURS, EMPLOYEE_TYPE, REST_GAP_SCOPE,
  workingWindow, restGapViolations, weekHoursOver,
  workingTimeAdvisories, candidateWorkingTime,
  hoursMinutesLabel, longWeeksHeadline, restGapsHeadline,
} from './working-time.js'

const HOUR = 60 * 60 * 1000

// One assignment, in the flat shape the reader returns. The block id is
// derived from person + date + start so a test can name it.
const S = (profile_id, block_date, start_time, end_time, over = {}) => ({
  profile_id,
  block_id: `${profile_id}-${block_date}-${start_time}`,
  block_date,
  start_time,
  end_time,
  location_id: 'loc1',
  location_name: 'Studio North',
  name: 'Class',
  status: 'scheduled',
  ...over,
})

describe('workingWindow', () => {
  it('resolves the window override, then block, then template', () => {
    expect(workingWindow(S('p1', '2026-09-22', '09:00:00', '12:00:00')))
      .toMatchObject({ profile_id: 'p1', date: '2026-09-22', start: '09:00', end: '12:00' })
    expect(workingWindow(S('p1', '2026-09-22', '09:00', '12:00', { start_time_override: '10:15', end_time_override: '12:30:00' })))
      .toMatchObject({ start: '10:15', end: '12:30' })
    expect(workingWindow(S('p1', '2026-09-22', null, null, { shift_templates: { start_time: '07:00', end_time: '08:30' } })))
      .toMatchObject({ start: '07:00', end: '08:30' })
  })

  it('is a real instant: 09:00 in September is 08:00 UTC, in November 09:00 UTC', () => {
    const sep = workingWindow(S('p1', '2026-09-22', '09:00', '12:00'))
    expect(sep.startMs).toBe(Date.UTC(2026, 8, 22, 8, 0))
    expect(sep.endMs - sep.startMs).toBe(3 * HOUR)
    expect(workingWindow(S('p1', '2026-11-03', '09:00', '12:00')).startMs).toBe(Date.UTC(2026, 10, 3, 9, 0))
  })

  it('a window through a clock change is its real length (25 Oct 2026 back, 29 Mar 2026 forward)', () => {
    const back = workingWindow(S('p1', '2026-10-25', '00:30', '03:30'))
    expect(back.startMs).toBe(Date.UTC(2026, 9, 24, 23, 30)) // 00:30 IST
    expect(back.endMs - back.startMs).toBe(4 * HOUR)
    const fwd = workingWindow(S('p1', '2026-03-29', '00:30', '03:30'))
    expect(fwd.endMs - fwd.startMs).toBe(2 * HOUR)
  })

  it('an end before the start runs into the next day, and the shift stays on its block date', () => {
    const w = workingWindow(S('p1', '2026-09-22', '22:00', '02:00'))
    expect(w.date).toBe('2026-09-22')
    expect(w.endMs).toBe(Date.UTC(2026, 8, 23, 1, 0)) // 02:00 IST on the 23rd
    expect(w.endMs - w.startMs).toBe(4 * HOUR)
  })

  it('is null for a cancelled row, no person, an unreadable date or time, or zero length', () => {
    expect(workingWindow(S('p1', '2026-09-22', '09:00', '12:00', { status: 'cancelled' }))).toBeNull()
    expect(workingWindow(S(null, '2026-09-22', '09:00', '12:00'))).toBeNull()
    expect(workingWindow(S('p1', '22/09/2026', '09:00', '12:00'))).toBeNull()
    expect(workingWindow(S('p1', '2026-09-22', '9am', '12:00'))).toBeNull()
    expect(workingWindow(S('p1', '2026-09-22', '25:00', '12:00'))).toBeNull()
    expect(workingWindow(S('p1', '2026-09-22', '09:00', '09:00'))).toBeNull()
    expect(workingWindow(null)).toBeNull()
  })
})

describe('restGapViolations', () => {
  it('exactly 11 hours is fine', () => {
    expect(restGapViolations([S('p1', '2026-09-22', '18:00', '21:00'), S('p1', '2026-09-23', '08:00', '10:00')])).toEqual([])
  })

  it('10h 59m flags', () => {
    const v = restGapViolations([S('p1', '2026-09-22', '18:00', '21:01'), S('p1', '2026-09-23', '08:00', '10:00')])
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({
      profile_id: 'p1', rest_minutes: 659,
      before: { date: '2026-09-22', end: '21:01' }, after: { date: '2026-09-23', start: '08:00' },
    })
  })

  it('split shifts inside one working day never flag; the day\'s last end to the next day\'s first start is what counts', () => {
    const v = restGapViolations([
      S('p1', '2026-09-22', '06:30', '08:00'),
      S('p1', '2026-09-22', '18:00', '21:30'), // 10 hours after the first: same day, not a rest
      S('p1', '2026-09-23', '07:00', '09:00'),
    ])
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ rest_minutes: 570, before: { start: '18:00', end: '21:30' }, after: { start: '07:00' } })
  })

  it('a pair across the two studios flags, carrying both studios', () => {
    expect(restGapViolations([
      S('p1', '2026-09-22', '20:00', '22:00', { location_id: 'loc2', location_name: 'Studio South' }),
      S('p1', '2026-09-23', '06:30', '09:00'),
    ])).toEqual([{
      profile_id: 'p1',
      rest_minutes: 510,
      before: { block_id: 'p1-2026-09-22-20:00', date: '2026-09-22', start: '20:00', end: '22:00', name: 'Class', location_id: 'loc2', location_name: 'Studio South' },
      after: { block_id: 'p1-2026-09-23-06:30', date: '2026-09-23', start: '06:30', end: '09:00', name: 'Class', location_id: 'loc1', location_name: 'Studio North' },
    }])
  })

  it('people are judged separately, and a day off in between is never a short rest', () => {
    expect(restGapViolations([S('p1', '2026-09-22', '20:00', '22:00'), S('p2', '2026-09-23', '06:00', '08:00')])).toEqual([])
    expect(restGapViolations([S('p1', '2026-09-22', '20:00', '23:00'), S('p1', '2026-09-24', '06:00', '08:00')])).toEqual([])
  })

  it('clocks going back: Sat 24 Oct 22:00 to Sun 25 Oct 08:00 is 11 real hours; 22:30 is 10h 30m', () => {
    expect(restGapViolations([S('p1', '2026-10-24', '18:00', '22:00'), S('p1', '2026-10-25', '08:00', '12:00')])).toEqual([])
    expect(restGapViolations([S('p1', '2026-10-24', '18:00', '22:30'), S('p1', '2026-10-25', '08:00', '12:00')])
      .map((v) => v.rest_minutes)).toEqual([630])
  })

  it('clocks going forward: Sat 28 Mar 21:00 to Sun 29 Mar 08:00 is 10 real hours', () => {
    expect(restGapViolations([S('p1', '2026-03-28', '18:00', '21:00'), S('p1', '2026-03-29', '08:00', '12:00')])
      .map((v) => v.rest_minutes)).toEqual([600])
  })

  it('honours a per-coach override: a coach kept until 22:00 has 10 hours before an 08:00 start', () => {
    expect(restGapViolations([
      S('p1', '2026-09-22', '18:00', '20:00', { end_time_override: '22:00' }),
      S('p1', '2026-09-23', '08:00', '10:00'),
    ]).map((v) => v.rest_minutes)).toEqual([600])
  })

  // OWNER REVIEW (WORKTIME.1 review note 2): rest is measured between WORKING
  // DAYS. REST_GAP_SCOPE is the one-line switch to every consecutive pair of
  // shifts; both readings are pinned so flipping it is a known change.
  it('REST_GAP_SCOPE defaults to working days; the per-shift reading flags a split shift', () => {
    const split = [S('p1', '2026-09-22', '06:30', '08:00'), S('p1', '2026-09-22', '18:00', '21:00')]
    expect(REST_GAP_SCOPE).toBe('working_day')
    expect(restGapViolations(split)).toEqual([])
    expect(restGapViolations(split, { restScope: 'shift' }).map((v) => [v.rest_minutes, v.before.start, v.after.start]))
      .toEqual([[600, '06:30', '18:00']])
    // Per-shift still never pairs two people, and 11h exactly still passes.
    expect(restGapViolations([S('p1', '2026-09-22', '06:00', '08:00'), S('p1', '2026-09-22', '19:00', '21:00')], { restScope: 'shift' })).toEqual([])
  })
})
