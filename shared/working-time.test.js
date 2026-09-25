// WORKTIME.1 — working-time advisories for employees: 11 hours between working
// days, 48 hours in a Monday-to-Sunday week, every studio of the organisation.
// Pure: no clock, no database. Run under TZ=Europe/Dublin AND a US zone; the
// rules must not move with the host.

import { describe, it, expect } from 'vitest'
import {
  MIN_REST_HOURS, MAX_WEEK_HOURS, EMPLOYEE_TYPE, REST_GAP_SCOPE, REST_BETWEEN_LABEL, isWorkingTimeCovered,
  workingWindow, restGapViolations, weekHoursOver,
  workingTimeAdvisories, candidateWorkingTime,
  hoursMinutesLabel, longWeeksHeadline, restGapsHeadline,
  untimedShiftCount, untimedShiftsLabel,
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

  it('the next spring-forward night too (Sun 28 Mar 2027): 00:30-03:30 is 2 real hours', () => {
    const fwd = workingWindow(S('p1', '2027-03-28', '00:30', '03:30'))
    expect(fwd.startMs).toBe(Date.UTC(2027, 2, 28, 0, 30)) // 00:30 GMT
    expect(fwd.endMs - fwd.startMs).toBe(2 * HOUR)
  })

  it('an end before the start runs into the next day, and the shift stays on its block date', () => {
    const w = workingWindow(S('p1', '2026-09-22', '22:00', '02:00'))
    expect(w.date).toBe('2026-09-22')
    expect(w.endMs).toBe(Date.UTC(2026, 8, 23, 1, 0)) // 02:00 IST on the 23rd
    expect(w.endMs - w.startMs).toBe(4 * HOUR)
  })

  it('an end of 24:00 is midnight at the END of the block date, never a dropped shift', () => {
    for (const end of ['24:00', '24:00:00']) {
      const w = workingWindow(S('p1', '2026-09-22', '20:00', end))
      expect(w).toMatchObject({ date: '2026-09-22', start: '20:00', end: '00:00' })
      expect(w.endMs).toBe(Date.UTC(2026, 8, 22, 23, 0)) // 00:00 IST on the 23rd
      expect(w.endMs - w.startMs).toBe(4 * HOUR)
    }
    // A whole day, 00:00-24:00, is 24 hours, not zero length.
    const day = workingWindow(S('p1', '2026-11-03', '00:00', '24:00:00'))
    expect(day.endMs - day.startMs).toBe(24 * HOUR)
    // 24:00 is an END only, and nothing past it parses.
    expect(workingWindow(S('p1', '2026-09-22', '24:00', '23:00'))).toBeNull()
    expect(workingWindow(S('p1', '2026-09-22', '20:00', '24:01'))).toBeNull()
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

  it('clocks going forward in 2027: Sat 27 Mar 21:00 to Sun 28 Mar 08:00 is 10 real hours', () => {
    expect(restGapViolations([S('p1', '2027-03-27', '18:00', '21:00'), S('p1', '2027-03-28', '08:00', '12:00')])
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

describe('24:00 ends and shifts without times (WORKTIME.1 review)', () => {
  it('a 24:00 end counts its hours in the week and ends the day for the rest', () => {
    const SIX = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']
    const rows = [...SIX.map((d) => S('p1', d, '09:00', '17:00')), S('p1', '2026-09-26', '15:45', '24:00:00')] // 40h + 8h15m
    expect(weekHoursOver(rows)).toMatchObject([{ minutes: 2895 }])
    expect(restGapViolations([S('p1', '2026-09-22', '18:00', '24:00:00'), S('p1', '2026-09-23', '08:00', '10:00')])
      .map((v) => [v.rest_minutes, v.before.end])).toEqual([[480, '00:00']])
  })

  it('untimedShiftCount counts live shifts with no usable start or end, once per block', () => {
    const noTimes = S('p1', '2026-09-22', null, null)
    expect(untimedShiftCount([
      noTimes, noTimes, // the same block reached twice
      S('p1', '2026-09-23', '09:00', null),
      S('p1', '2026-09-24', 'late', '12:00'),
      S('p1', '2026-09-25', '09:00', '12:00'), // timed
      S('p1', '2026-09-25', '09:00', '24:00'), // timed: 24:00 is an end
      S('p1', '2026-09-26', null, null, { status: 'cancelled' }), // not a shift
      S(null, '2026-09-26', null, null), // nobody on it
      S('p1', '2026-09-27', '09:00', '09:00'), // zero length is timed, it is 0 hours
    ])).toBe(3)
    expect(untimedShiftCount(null)).toBe(0)
  })

  it('the publish list carries the count, for covered people only', () => {
    const out = workingTimeAdvisories([
      S('emp', '2026-09-22', null, null),
      S('con', '2026-09-22', null, null),
    ], { people: new Map([['emp', { employment_type: 'fte' }], ['con', { employment_type: 'contractor' }]]) })
    expect(out).toEqual({ restGaps: [], longWeeks: [], untimed: 1 })
  })

  it('untimedShiftsLabel', () => {
    expect([1, 3].map(untimedShiftsLabel)).toEqual([
      '1 shift without times was not counted.',
      '3 shifts without times were not counted.',
    ])
  })
})

describe('weekHoursOver', () => {
  const SIX = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']
  const six = (lastEnd = '17:00') => SIX.map((d, i) => S('p1', d, '09:00', i === 5 ? lastEnd : '17:00'))
  const FIVE = SIX.slice(0, 5).map((d) => S('p1', d, '09:00', '17:00')) // 40h

  it('48.0 hours is fine', () => {
    expect(weekHoursOver(six())).toEqual([])
  })

  it('48.25 hours flags', () => {
    expect(weekHoursOver(six('17:15'))).toEqual([{
      profile_id: 'p1', week_start: '2026-09-21', minutes: 2895, shift_count: 6,
      block_ids: SIX.map((d) => `p1-${d}-09:00`), location_ids: ['loc1'],
    }])
  })

  it('sums both studios, and the limit is a parameter', () => {
    const rows = [
      ...SIX.map((d, i) => S('p1', d, '09:00', '17:00', i % 2 ? { location_id: 'loc2', location_name: 'Studio South' } : {})),
      S('p1', '2026-09-27', '10:00', '11:00', { location_id: 'loc2', location_name: 'Studio South' }),
    ]
    expect(weekHoursOver(rows)).toMatchObject([{ minutes: 2940, shift_count: 7, location_ids: ['loc1', 'loc2'] }])
    expect(weekHoursOver(rows, 50)).toEqual([])
  })

  it('Monday to Sunday: a Sunday belongs to the week that began the Monday before; the next Monday starts afresh', () => {
    expect(weekHoursOver([...FIVE, S('p1', '2026-09-27', '09:00', '18:00')])).toMatchObject([{ week_start: '2026-09-21', minutes: 2940 }])
    expect(weekHoursOver([...FIVE, S('p1', '2026-09-28', '09:00', '18:00')])).toEqual([])
  })

  it('the DST week (w/c 19 Oct 2026): Sunday 25 Oct counts in it, 48.0 is fine and 48.25 flags', () => {
    const OCT = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'].map((d) => S('p1', d, '09:00', '17:00'))
    expect(weekHoursOver([...OCT, S('p1', '2026-10-25', '09:00', '17:00')])).toEqual([])
    expect(weekHoursOver([...OCT, S('p1', '2026-10-25', '09:00', '17:15')])).toMatchObject([{ week_start: '2026-10-19', minutes: 2895 }])
  })

  it('a shift through the clock change counts its real hours (wall clock would say 47h 15m)', () => {
    const OCT = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'].map((d) => S('p1', d, '09:00', '17:00'))
    expect(weekHoursOver([
      ...OCT,
      S('p1', '2026-10-24', '09:00', '13:15'),
      S('p1', '2026-10-25', '00:30', '03:30'), // 4 real hours
    ])).toMatchObject([{ week_start: '2026-10-19', minutes: 2895 }])
  })

  it('a cancelled row does not count, and a row listed twice counts once', () => {
    const rows = six('17:15')
    expect(weekHoursOver([...rows, rows[0], S('p1', '2026-09-27', '09:00', '17:00', { status: 'cancelled' })]))
      .toMatchObject([{ minutes: 2895, shift_count: 6 }])
  })
})

const PEOPLE = new Map([
  ['emp', { full_name: 'Sam Demo', employment_type: 'fte' }],
  ['emp2', { full_name: 'Toby Beta', employment_type: 'fte' }],
  ['con', { full_name: 'Max Beta', employment_type: 'contractor' }],
])
const WEEK = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']
const NEXT_WEEK = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']
// 50 hours in five days, and 8 hours' rest after the first day.
const heavy = (pid, [d1, d2, d3, d4, d5], over = {}) => [
  S(pid, d1, '12:00', '22:00', over),
  S(pid, d2, '06:00', '16:00', over),
  S(pid, d3, '06:00', '16:00', over),
  S(pid, d4, '06:00', '16:00', over),
  S(pid, d5, '06:00', '16:00', over),
]
const OPTS = { people: PEOPLE, hereLocationId: 'loc1', from: '2026-09-21', to: '2026-09-27', todayIso: '2026-09-21' }

describe('workingTimeAdvisories', () => {
  it('a contractor is never flagged, whatever their hours or rest', () => {
    const out = workingTimeAdvisories([...heavy('emp', WEEK), ...heavy('con', WEEK)], OPTS)
    expect(out.restGaps.map((g) => [g.profile_id, g.rest_minutes])).toEqual([['emp', 480]])
    expect(out.longWeeks.map((w) => [w.profile_id, w.minutes])).toEqual([['emp', 3000]])
  })

  it('a person whose employment type is unknown is not flagged', () => {
    expect(workingTimeAdvisories(heavy('ghost', WEEK), OPTS)).toEqual({ restGaps: [], longWeeks: [], untimed: 0 })
    expect(workingTimeAdvisories(heavy('emp', WEEK), { ...OPTS, people: null })).toEqual({ restGaps: [], longWeeks: [], untimed: 0 })
  })

  it('names the other studio, never this one, and the coach', () => {
    const out = workingTimeAdvisories([
      S('emp', '2026-09-22', '20:00', '22:00', { location_id: 'loc2', location_name: 'Studio South', name: 'Evening' }),
      S('emp', '2026-09-23', '06:30', '09:00', { name: 'Early' }),
    ], OPTS)
    expect(out.restGaps).toEqual([{
      profile_id: 'emp', coach_name: 'Sam Demo', rest_minutes: 510,
      before: { block_id: 'emp-2026-09-22-20:00', date: '2026-09-22', start: '20:00', end: '22:00', name: 'Evening', location_name: 'Studio South' },
      after: { block_id: 'emp-2026-09-23-06:30', date: '2026-09-23', start: '06:30', end: '09:00', name: 'Early', location_name: null },
    }])
    expect(out.longWeeks).toEqual([])
  })

  it('lists only what this studio\'s publish is about: nothing that lives entirely at the other studio', () => {
    const away = heavy('emp', WEEK, { location_id: 'loc2', location_name: 'Studio South' })
    expect(workingTimeAdvisories(away, OPTS)).toEqual({ restGaps: [], longWeeks: [], untimed: 0 })
    const unscoped = workingTimeAdvisories(away, { ...OPTS, hereLocationId: null })
    expect(unscoped.restGaps).toHaveLength(1)
    expect(unscoped.longWeeks).toMatchObject([{ studio_count: 1, shift_count: 5 }])
  })

  it('period and today: a past pair is dropped, a Sunday-close-Monday-open pair across the period end is kept', () => {
    const out = workingTimeAdvisories([
      S('emp', '2026-09-21', '20:00', '22:00'), S('emp', '2026-09-22', '06:00', '08:00'), // before today: history
      S('emp', '2026-09-27', '19:00', '22:00'), // last day of the period, here
      S('emp', '2026-09-28', '06:00', '08:00', { location_id: 'loc2', location_name: 'Studio South' }), // day after, elsewhere
      S('emp', '2026-09-28', '20:00', '22:00'), S('emp', '2026-09-29', '06:00', '08:00'), // wholly after the period
      ...heavy('emp2', NEXT_WEEK), // a long week that is next week's publish
    ], { ...OPTS, todayIso: '2026-09-23' })
    expect(out.restGaps.map((g) => [g.profile_id, g.before.date, g.after.date, g.after.location_name]))
      .toEqual([['emp', '2026-09-27', '2026-09-28', 'Studio South']])
    expect(out.longWeeks).toEqual([])
  })

  it('hours only: no pay, cost or employment field in the answer', () => {
    const out = workingTimeAdvisories(heavy('emp', WEEK), OPTS)
    expect(out.longWeeks).toEqual([{ profile_id: 'emp', coach_name: 'Sam Demo', week_start: '2026-09-21', minutes: 3000, shift_count: 5, studio_count: 1 }])
    expect(JSON.stringify(out)).not.toMatch(/rate|salary|cost|€|employment/i)
  })
})

describe('candidateWorkingTime', () => {
  const HERE = { hereLocationId: 'loc1' }

  it('flags the short rest assigning would create, naming the other shift, on either side', () => {
    const late = S('emp', '2026-09-22', '20:00', '22:00', { location_id: 'loc2', location_name: 'Studio South', name: 'Evening' })
    expect(candidateWorkingTime([late], S('emp', '2026-09-23', '06:30', '08:00'), HERE)).toEqual({
      restGap: {
        rest_minutes: 510, side: 'before',
        other: { block_id: 'emp-2026-09-22-20:00', date: '2026-09-22', start: '20:00', end: '22:00', name: 'Evening', location_name: 'Studio South' },
      },
      weekHours: null,
    })
    expect(candidateWorkingTime([S('emp', '2026-09-24', '06:00', '08:00')], S('emp', '2026-09-23', '19:00', '22:00'), HERE).restGap)
      .toEqual({
        rest_minutes: 480, side: 'after',
        other: { block_id: 'emp-2026-09-24-06:00', date: '2026-09-24', start: '06:00', end: '08:00', name: 'Class', location_name: null },
      })
  })

  it('says nothing when the rest stays at 11 hours or more', () => {
    expect(candidateWorkingTime([S('emp', '2026-09-22', '12:00', '19:00')], S('emp', '2026-09-23', '06:30', '08:00'), HERE))
      .toEqual({ restGap: null, weekHours: null })
  })

  it('does not blame the candidate for a short rest it does not touch', () => {
    const own = [S('emp', '2026-09-21', '18:00', '21:00'), S('emp', '2026-09-22', '06:00', '08:00')] // 9h already
    expect(candidateWorkingTime(own, S('emp', '2026-09-24', '10:00', '12:00'), HERE).restGap).toBeNull()
  })

  it('flags a week the shift would take over 48 hours; exactly 48 is fine', () => {
    const own = WEEK.map((d) => S('emp', d, '09:00', '18:00')) // 45h
    expect(candidateWorkingTime(own, S('emp', '2026-09-26', '09:00', '13:00'), HERE).weekHours)
      .toEqual({ week_start: '2026-09-21', minutes: 2940 })
    expect(candidateWorkingTime(own, S('emp', '2026-09-26', '09:00', '12:00'), HERE).weekHours).toBeNull()
  })

  it('ignores the candidate block already in the list, and other people\'s shifts', () => {
    const cand = S('emp', '2026-09-23', '06:30', '08:00')
    const others = [S('other', '2026-09-22', '20:00', '22:00'), cand]
    expect(candidateWorkingTime(others, cand, HERE)).toEqual({ restGap: null, weekHours: null })
  })
})

describe('copy', () => {
  it('hoursMinutesLabel', () => {
    expect([659, 660, 45, 2895, 0, -5].map(hoursMinutesLabel)).toEqual(['10h 59m', '11h', '45m', '48h 15m', '0m', '0m'])
  })

  it('headlines count people for weeks and rests for rests, and the limits are pinned', () => {
    expect(longWeeksHeadline([{ profile_id: 'a' }, { profile_id: 'a' }])).toBe('1 employee over 48 hours in a week')
    expect(longWeeksHeadline([{ profile_id: 'a' }, { profile_id: 'b' }])).toBe('2 employees over 48 hours in a week')
    expect(restGapsHeadline([{}])).toBe('1 rest under 11 hours between working days')
    expect(restGapsHeadline([{}, {}])).toBe('2 rests under 11 hours between working days')
    expect([MIN_REST_HOURS, MAX_WEEK_HOURS, EMPLOYEE_TYPE, REST_BETWEEN_LABEL]).toEqual([11, 48, 'fte', 'between working days'])
  })
})

describe('isWorkingTimeCovered', () => {
  // OWNER REVIEW: who the Act's rules are applied to. EMPLOYEE_TYPE is the one
  // line to change; every reader and rule asks through this.
  it('covers an employee only: never a contractor, never an unknown type', () => {
    expect(['fte', 'contractor', null, undefined, '', 'casual'].map(isWorkingTimeCovered))
      .toEqual([true, false, false, false, false, false])
  })
})
