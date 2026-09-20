// RUNWAY.1 — the roster runway: which upcoming week is not ready, and how loud.
// Pure date-string arithmetic: no clock, no timezone, no database.
//
// The runway is about weeks that START IN THE FUTURE (Monday > today). The
// current week already has its surfaces: the Today page's staffing-gap card
// counts empty and short shifts from today to Sunday, and the schedule banner
// covers publication.

import { describe, it, expect } from 'vitest'
import {
  RUNWAY_AMBER_DAYS, RUNWAY_RED_DAYS,
  runwayWindow, runwayWeeksFromBlocks, rosterRunway, rosterRunwayWeeks, rosterRunwayHeadline, rosterRunwayDetail,
} from './roster-runway.js'

const ready = (weekStart, n = 34) => ({ weekStart, blocks: n, staffed: n, underMin: 0, published: n })
const unbuilt = (weekStart, n = 34) => ({ weekStart, blocks: n, staffed: 0, underMin: 0, published: 0 })

// The live case: Sat 19 Sep 2026. This week and next are fine; w/c 28 Sep is not.
const LIVE = [ready('2026-09-14', 4), ready('2026-09-21'), unbuilt('2026-09-28')]

describe('runwayWindow', () => {
  it('is NEXT Monday to the Sunday of the week after: the current week is never read', () => {
    expect(runwayWindow('2026-09-19')).toEqual({
      from: '2026-09-21', to: '2026-10-04', weekStarts: ['2026-09-21', '2026-09-28'],
    })
  })
  it('on a Monday the week that starts today is already "this week"; a Sunday looks at tomorrow', () => {
    expect(runwayWindow('2026-09-21').weekStarts).toEqual(['2026-09-28', '2026-10-05'])
    expect(runwayWindow('2026-09-27').weekStarts).toEqual(['2026-09-28', '2026-10-05'])
  })
  it('two weeks is the whole horizon: the third upcoming Monday is never within 10 days', () => {
    for (let ms = Date.UTC(2026, 8, 14); ms <= Date.UTC(2026, 8, 20); ms += 24 * 60 * 60 * 1000) {
      const today = new Date(ms).toISOString().slice(0, 10)
      const third = { weekStart: '2026-10-05', blocks: 3, staffed: 0, underMin: 0, published: 0 }
      expect(rosterRunway([third], today)).toBeNull()
    }
  })
  it('DST weeks are still seven calendar days (25 Oct 2026 is a 25-hour day, 29 Mar a 23-hour one)', () => {
    expect(runwayWindow('2026-10-25').weekStarts).toEqual(['2026-10-26', '2026-11-02'])
    expect(runwayWindow('2026-03-29').weekStarts).toEqual(['2026-03-30', '2026-04-06'])
  })
  it('crosses the year: on 23 Dec the window is 28 Dec to 10 Jan', () => {
    expect(runwayWindow('2026-12-23')).toEqual({ from: '2026-12-28', to: '2027-01-10', weekStarts: ['2026-12-28', '2027-01-04'] })
  })
})

describe('rosterRunway', () => {
  it('the live case: 19 Sep, w/c 28 Sep is 9 days off with 0 of 34 staffed and nothing published -> amber', () => {
    expect(rosterRunway(LIVE, '2026-09-19')).toEqual({
      weekStart: '2026-09-28', daysAway: 9, severity: 'amber',
      blocks: 34, staffed: 0, underMin: 0, published: 0, unstaffed: 34, unpublished: 34,
    })
  })

  // [today, expected severity or null] for the same unbuilt w/c 28 Sep
  it.each([
    ['2026-09-17', null],    // 11 days: outside the horizon
    ['2026-09-18', 'amber'], // 10 days: the horizon is inclusive
    ['2026-09-22', 'amber'], // 6 days
    ['2026-09-23', 'red'],   // 5 days: the red line is inclusive
    ['2026-09-27', 'red'],   // tomorrow: the last day it is on the runway
    ['2026-09-28', null],    // it is now THIS week: the staffing card's and the banner's job
    ['2026-10-04', null],    // its Sunday
    ['2026-10-05', null],    // fully past
  ])('on %s the unbuilt week of 28 Sep reads %s', (today, severity) => {
    expect(rosterRunway([unbuilt('2026-09-28')], today)?.severity ?? null).toBe(severity)
  })

  // The push dedups per (studio, week, severity). That is only "amber once,
  // then red once" because a week's severity can never go BACK: walk every
  // day from two weeks before the Monday to its Sunday and the sequence must
  // be nulls, then ambers, then reds, then (once it has started) nothing.
  it('for one week severity only ever escalates: red is never followed by amber', () => {
    const seen = []
    for (let ms = Date.UTC(2026, 8, 14); ms <= Date.UTC(2026, 9, 4); ms += 24 * 60 * 60 * 1000) {
      const today = new Date(ms).toISOString().slice(0, 10)
      seen.push(rosterRunway([unbuilt('2026-09-28')], today)?.severity ?? 'none')
    }
    const collapsed = seen.filter((s, i) => s !== seen[i - 1])
    expect(collapsed).toEqual(['none', 'amber', 'red', 'none'])
    expect(seen.filter((s) => s === 'amber')).toHaveLength(5) // days 10..6
    expect(seen.filter((s) => s === 'red')).toHaveLength(5)   // days 5..1
  })

  // THE REGRESSION. As first built, the current week counted: one empty shift
  // this week made w/c 14 Sep the "first unready week", which masked the chip
  // for the unbuilt w/c 28 Sep and sent a red "This week: ..." push.
  it('a gap in the CURRENT week neither masks nor raises anything: 19 Sep -> w/c 28 Sep, amber', () => {
    const gapThisWeek = { weekStart: '2026-09-14', blocks: 4, staffed: 3, underMin: 0, published: 4 }
    const weeks = [gapThisWeek, ready('2026-09-21'), unbuilt('2026-09-28')]
    expect(rosterRunway(weeks, '2026-09-19')).toMatchObject({ weekStart: '2026-09-28', daysAway: 9, severity: 'amber' })
    expect(rosterRunwayWeeks(weeks, '2026-09-19').map((r) => r.weekStart)).toEqual(['2026-09-28'])
    expect(rosterRunway([gapThisWeek], '2026-09-19')).toBeNull()
    expect(rosterRunway([gapThisWeek], '2026-09-14')).toBeNull() // its own Monday: daysAway 0
  })

  it('on a Sunday next Monday is one day off: red, "Starts tomorrow"', () => {
    const r = rosterRunway([unbuilt('2026-09-21')], '2026-09-20')
    expect(r).toMatchObject({ weekStart: '2026-09-21', daysAway: 1, severity: 'red' })
    expect(rosterRunwayDetail(r)).toBe('Starts tomorrow: 34 of 34 shifts have no coach, not published.')
  })

  it('across the year boundary: on 23 Dec the week of 28 Dec (to 3 Jan) is 5 days off -> red', () => {
    expect(rosterRunway([unbuilt('2026-12-28')], '2026-12-23')).toMatchObject({ weekStart: '2026-12-28', daysAway: 5, severity: 'red' })
    expect(rosterRunway([unbuilt('2027-01-04')], '2026-12-25')).toMatchObject({ weekStart: '2027-01-04', daysAway: 10, severity: 'amber' })
    expect(rosterRunway([unbuilt('2027-01-04')], '2026-12-24')).toBeNull() // 11 days
  })

  it('pins the two thresholds the table above rests on', () => {
    expect(RUNWAY_AMBER_DAYS).toBe(10)
    expect(RUNWAY_RED_DAYS).toBe(5)
  })

  it('returns the FIRST unready week, even when a later one is worse', () => {
    const weeks = [ready('2026-09-14'), { ...ready('2026-09-21'), published: 30 }, unbuilt('2026-09-28')]
    expect(rosterRunway(weeks, '2026-09-19')).toMatchObject({ weekStart: '2026-09-21', severity: 'red', unpublished: 4, unstaffed: 0 })
  })

  it('input order does not matter', () => {
    expect(rosterRunway([...LIVE].reverse(), '2026-09-19').weekStart).toBe('2026-09-28')
  })

  it('staffed but unpublished is unready; published but with an empty block is unready', () => {
    expect(rosterRunway([{ ...ready('2026-09-28'), published: 0 }], '2026-09-19')).toMatchObject({ unstaffed: 0, unpublished: 34 })
    expect(rosterRunway([{ ...ready('2026-09-28'), staffed: 33 }], '2026-09-19')).toMatchObject({ unstaffed: 1, unpublished: 0 })
  })

  it('a fully staffed, fully published week is ready, and below-minimum alone does not raise it', () => {
    expect(rosterRunway([ready('2026-09-28')], '2026-09-19')).toBeNull()
    expect(rosterRunway([{ ...ready('2026-09-28'), underMin: 5 }], '2026-09-19')).toBeNull()
  })

  // DELIBERATE. This studio routinely runs several shifts one coach short
  // every week; alerting on that would push every week forever and teach
  // people to ignore the alert.
  it('published, every shift has at least one live coach, one shift below its minimum -> NO alert', () => {
    const block = (block_date, coaches, min) => ({
      block_date, min_coaches: min, rosters: { status: 'published' },
      shift_assignments: Array.from({ length: coaches }, () => ({ status: 'scheduled' })),
    })
    const weeks = runwayWeeksFromBlocks([block('2026-09-28', 2, 2), block('2026-09-29', 1, 2), block('2026-09-30', 1, 1)], '2026-09-19')
    expect(weeks[1]).toEqual({ weekStart: '2026-09-28', blocks: 3, staffed: 3, underMin: 1, published: 3 })
    expect(rosterRunway(weeks, '2026-09-19')).toBeNull()
    expect(rosterRunwayWeeks(weeks, '2026-09-19')).toEqual([])
    // ...but when the week alerts for ANOTHER reason, the body still says so.
    const unpublished = weeks.map((w) => ({ ...w, published: 0 }))
    expect(rosterRunwayDetail(rosterRunway(unpublished, '2026-09-19'))).toBe('Starts in 9 days: 1 below the minimum, not published.')
  })

  it('a studio with no blocks at all (no active shift templates) produces nothing', () => {
    const none = (ws) => ({ weekStart: ws, blocks: 0, staffed: 0, underMin: 0, published: 0 })
    expect(rosterRunway([none('2026-09-14'), none('2026-09-21'), none('2026-09-28')], '2026-09-19')).toBeNull()
  })

  it('tolerates null, empty and malformed input', () => {
    expect(rosterRunway(null, '2026-09-19')).toBeNull()
    expect(rosterRunway([], '2026-09-19')).toBeNull()
    expect(rosterRunway([{ blocks: 3 }, null], '2026-09-19')).toBeNull()
  })

  it('never reports more staffed or published than there are blocks', () => {
    expect(rosterRunway([{ weekStart: '2026-09-28', blocks: 2, staffed: 9, underMin: 0, published: 0 }], '2026-09-19'))
      .toMatchObject({ staffed: 2, unstaffed: 0, unpublished: 2 })
  })
})

// The PUSH must not be masked. One shift in NEXT week that cannot be filled
// keeps next week unready until it starts; if only the first unready week were
// ever announced, the week after would stay hidden until it was 7 days out,
// its amber swallowed for most of the days it exists to cover.
describe('rosterRunwayWeeks', () => {
  const gapNextWeek = { weekStart: '2026-09-21', blocks: 30, staffed: 29, underMin: 0, published: 30 }

  it('every unready week inside the horizon, soonest first; rosterRunway is its head', () => {
    const weeks = [unbuilt('2026-09-28'), gapNextWeek]
    const all = rosterRunwayWeeks(weeks, '2026-09-19')
    expect(all.map((r) => [r.weekStart, r.severity])).toEqual([['2026-09-21', 'red'], ['2026-09-28', 'amber']])
    expect(rosterRunway(weeks, '2026-09-19')).toEqual(all[0])
  })

  it('still stops at the horizon, and is empty (never null) when everything is ready', () => {
    expect(rosterRunwayWeeks([gapNextWeek, unbuilt('2026-09-28')], '2026-09-17').map((r) => r.weekStart)).toEqual(['2026-09-21'])
    expect(rosterRunwayWeeks(LIVE.slice(0, 2), '2026-09-19')).toEqual([])
    expect(rosterRunwayWeeks(null, '2026-09-19')).toEqual([])
  })
})

describe('runwayWeeksFromBlocks', () => {
  const block = (block_date, { coaches = 0, min = 1, roster = null, cancelled = 0 } = {}) => ({
    block_date,
    min_coaches: min,
    rosters: roster ? { status: roster } : null,
    shift_assignments: [
      ...Array.from({ length: coaches }, () => ({ status: 'scheduled' })),
      ...Array.from({ length: cancelled }, () => ({ status: 'cancelled' })),
    ],
  })

  it('counts the two UPCOMING Mon-Sun weeks only: nothing from the current week, nothing from a third', () => {
    const weeks = runwayWeeksFromBlocks([
      block('2026-09-18', { coaches: 0 }),                                   // yesterday: history
      block('2026-09-19', { coaches: 0 }),                                   // today, empty: THIS week, not the runway's business
      block('2026-09-20', { coaches: 0 }),                                   // this Sunday: likewise
      block('2026-09-28', { coaches: 1, min: 2 }),                           // short, unpublished
      block('2026-09-29', { coaches: 0, cancelled: 1, roster: 'superseded' }), // a cancelled coach is no coach; superseded is not published
      block('2026-10-05', { coaches: 0 }),                                   // a third upcoming week: out of the window
    ], '2026-09-19')
    expect(weeks).toEqual([
      { weekStart: '2026-09-21', blocks: 0, staffed: 0, underMin: 0, published: 0 },
      { weekStart: '2026-09-28', blocks: 2, staffed: 1, underMin: 1, published: 0 },
    ])
  })

  it('feeds rosterRunway: the same rows give the alert', () => {
    const weeks = runwayWeeksFromBlocks([block('2026-09-28', { coaches: 1, min: 2 }), block('2026-09-29')], '2026-09-19')
    expect(rosterRunway(weeks, '2026-09-19')).toMatchObject({ weekStart: '2026-09-28', blocks: 2, unstaffed: 1, underMin: 1, unpublished: 2 })
  })

  it('no rows -> two empty weeks', () => {
    expect(runwayWeeksFromBlocks(null, '2026-09-19').map((w) => [w.weekStart, w.blocks])).toEqual([['2026-09-21', 0], ['2026-09-28', 0]])
  })
})

describe('copy', () => {
  const r = rosterRunway(LIVE, '2026-09-19')
  it('headline names the week, and the studio when asked', () => {
    expect(rosterRunwayHeadline(r)).toBe('Week of 28 Sep is not ready')
    expect(rosterRunwayHeadline(r, { locationName: 'Studio North' })).toBe('Studio North: week of 28 Sep is not ready')
  })
  it('detail says how far off and what is missing', () => {
    expect(rosterRunwayDetail(r)).toBe('Starts in 9 days: 34 of 34 shifts have no coach, not published.')
    expect(rosterRunwayDetail({ ...r, daysAway: 1, staffed: 33, unstaffed: 1, underMin: 2, published: 30, unpublished: 4 }))
      .toBe('Starts tomorrow: 1 of 34 shifts has no coach, 2 below the minimum, 4 shifts not published.')
    expect(rosterRunwayDetail({ ...r, daysAway: 2, blocks: 1, unstaffed: 1, unpublished: 0 }))
      .toBe('Starts in 2 days: 1 of 1 shift has no coach.')
  })
})
