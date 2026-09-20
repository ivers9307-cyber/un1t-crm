// RUNWAY.1 — the roster runway: which upcoming week is not ready, and how loud.
// Pure date-string arithmetic: no clock, no timezone, no database.

import { describe, it, expect } from 'vitest'
import {
  RUNWAY_AMBER_DAYS, RUNWAY_RED_DAYS,
  runwayWindow, runwayWeeksFromBlocks, rosterRunway, rosterRunwayHeadline, rosterRunwayDetail,
} from './roster-runway.js'

const ready = (weekStart, n = 34) => ({ weekStart, blocks: n, staffed: n, underMin: 0, published: n })
const unbuilt = (weekStart, n = 34) => ({ weekStart, blocks: n, staffed: 0, underMin: 0, published: 0 })

// The live case: Sat 19 Sep 2026. This week and next are fine; w/c 28 Sep is not.
const LIVE = [ready('2026-09-14', 4), ready('2026-09-21'), unbuilt('2026-09-28')]

describe('runwayWindow', () => {
  it('is today to the Sunday of the third Mon-Sun week', () => {
    expect(runwayWindow('2026-09-19')).toEqual({
      from: '2026-09-19', to: '2026-10-04', weekStarts: ['2026-09-14', '2026-09-21', '2026-09-28'],
    })
  })
  it('a Monday is its own week start; a Sunday belongs to the week that began six days earlier', () => {
    expect(runwayWindow('2026-09-21').weekStarts[0]).toBe('2026-09-21')
    expect(runwayWindow('2026-09-27').weekStarts[0]).toBe('2026-09-21')
  })
  it('DST weeks are still seven calendar days (25 Oct 2026 is a 25-hour day, 29 Mar a 23-hour one)', () => {
    expect(runwayWindow('2026-10-25').weekStarts).toEqual(['2026-10-19', '2026-10-26', '2026-11-02'])
    expect(runwayWindow('2026-03-29').weekStarts).toEqual(['2026-03-23', '2026-03-30', '2026-04-06'])
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
    ['2026-09-27', 'red'],   // tomorrow
    ['2026-09-28', 'red'],   // it is now this week
    ['2026-10-04', 'red'],   // its Sunday
    ['2026-10-05', null],    // fully past
  ])('on %s the unbuilt week of 28 Sep reads %s', (today, severity) => {
    expect(rosterRunway([unbuilt('2026-09-28')], today)?.severity ?? null).toBe(severity)
  })

  // The push dedups per (studio, week, severity). That is only "amber once,
  // then red once" because a week's severity can never go BACK: walk every
  // day from two weeks before the Monday to its Sunday and the sequence must
  // be nulls, then ambers, then reds, and nothing after a red but red.
  it('for one week severity only ever escalates: red is never followed by amber', () => {
    const seen = []
    for (let ms = Date.UTC(2026, 8, 14); ms <= Date.UTC(2026, 9, 4); ms += 24 * 60 * 60 * 1000) {
      const today = new Date(ms).toISOString().slice(0, 10)
      seen.push(rosterRunway([unbuilt('2026-09-28')], today)?.severity ?? 'none')
    }
    const collapsed = seen.filter((s, i) => s !== seen[i - 1])
    expect(collapsed).toEqual(['none', 'amber', 'red'])
    expect(seen.filter((s) => s === 'amber')).toHaveLength(5) // days 10..6
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
