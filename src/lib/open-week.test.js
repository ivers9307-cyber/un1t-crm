// OPENWEEK.1 — the open week rules.
import { describe, it, expect } from 'vitest'
import {
  isOpenWeek, openWeekState, openWeekReadDays, openWeekStartMs, inOpenWeek, judgeOpenWeekPicks, openWeekExpiresInDays,
} from './open-week'

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
const PROMO = { key: 'hatch-open-week', kind: 'open_week', windowStartsOn: '2026-11-23', windowEndsOn: '2026-11-30', maxClasses: 5, maxPerDay: 1 }
const at = (iso) => new Date(iso)
const cls = (id, day, hh = '07') => ({ event_id: id, name: `Class ${id}`, starts_at: `${day}T${hh}:00:00.000Z`, day })

describe('isOpenWeek', () => {
  it('is true only for an open week promo with its window', () => {
    expect(isOpenWeek(PROMO)).toBe(true)
    expect(isOpenWeek({ ...PROMO, kind: 'promo' })).toBe(false)
    expect(isOpenWeek({ ...PROMO, windowEndsOn: null })).toBe(false)
    expect(isOpenWeek(null)).toBe(false)
  })
})

describe('openWeekState', () => {
  it('is open before and during the week, over after its last day', () => {
    expect(openWeekState(PROMO, DUB, at('2026-11-16T12:00:00Z'))).toBe('open')
    expect(openWeekState(PROMO, DUB, at('2026-11-30T23:30:00Z'))).toBe('open')
    expect(openWeekState(PROMO, DUB, at('2026-12-01T00:30:00Z'))).toBe('over')
  })

  it('judges the day on the studio clock', () => {
    expect(openWeekState(PROMO, DUB, at('2026-12-01T03:00:00Z'))).toBe('over')
    expect(openWeekState(PROMO, NY, at('2026-12-01T03:00:00Z'))).toBe('open')
  })
})

describe('openWeekReadDays / openWeekStartMs', () => {
  it('reaches the last day of the week, counted from today', () => {
    expect(openWeekReadDays(PROMO, DUB, at('2026-11-16T12:00:00Z'))).toBe(15)
    expect(openWeekReadDays(PROMO, DUB, at('2026-11-28T20:00:00Z'))).toBe(3)
    expect(openWeekReadDays(PROMO, DUB, at('2026-12-02T12:00:00Z'))).toBe(1)
  })

  it('the window opens at 00:00 on its first day in the studio zone', () => {
    expect(openWeekStartMs(PROMO, DUB)).toBe(Date.parse('2026-11-23T00:00:00Z'))
    expect(openWeekStartMs(PROMO, NY)).toBe(Date.parse('2026-11-23T05:00:00Z'))
  })
})

describe('inOpenWeek', () => {
  it('admits a class whose studio-local day is inside the window, both ends included', () => {
    expect(inOpenWeek(cls('a', '2026-11-23'), PROMO)).toBe(true)
    expect(inOpenWeek(cls('a', '2026-11-30'), PROMO)).toBe(true)
    expect(inOpenWeek(cls('a', '2026-11-22'), PROMO)).toBe(false)
    expect(inOpenWeek(cls('a', '2026-12-01'), PROMO)).toBe(false)
    expect(inOpenWeek({ event_id: 'x' }, PROMO)).toBe(false)
  })
})

describe('judgeOpenWeekPicks', () => {
  const classes = [cls('a', '2026-11-24'), cls('a2', '2026-11-24', '18'), cls('b', '2026-11-25'), cls('c', '2026-11-26'), cls('d', '2026-11-27'), cls('e', '2026-11-28'), cls('f', '2026-11-29')]

  it('refuses no picks', () => {
    expect(judgeOpenWeekPicks([], classes, PROMO)).toEqual({ ok: false, code: 'none_picked' })
  })

  it('refuses more than the most classes', () => {
    expect(judgeOpenWeekPicks(['a', 'b', 'c', 'd', 'e', 'f'], classes, PROMO)).toEqual({ ok: false, code: 'too_many' })
  })

  it('refuses two on one day', () => {
    expect(judgeOpenWeekPicks(['a', 'a2'], classes, PROMO)).toEqual({ ok: false, code: 'two_on_one_day' })
  })

  it('names a class that is not in the read', () => {
    expect(judgeOpenWeekPicks(['a', 'zz'], classes, PROMO)).toEqual({ ok: false, code: 'class_unavailable', eventId: 'zz' })
  })

  it('dedupes and orders the picks by start', () => {
    const r = judgeOpenWeekPicks(['b', 'a', 'a'], classes, PROMO)
    expect(r).toEqual({ ok: true, picks: [
      { event_id: 'a', name: 'Class a', starts_at: '2026-11-24T07:00:00.000Z', day: '2026-11-24' },
      { event_id: 'b', name: 'Class b', starts_at: '2026-11-25T07:00:00.000Z', day: '2026-11-25' },
    ] })
  })
})

describe('openWeekExpiresInDays', () => {
  it('is the fewest whole days that cover the end of the last day', () => {
    expect(openWeekExpiresInDays(PROMO, DUB, at('2026-11-16T12:00:00Z'))).toBe(15)
    expect(openWeekExpiresInDays(PROMO, DUB, at('2026-11-30T22:00:00Z'))).toBe(1)
  })

  it('counts to midnight in the studio zone', () => {
    expect(openWeekExpiresInDays(PROMO, NY, at('2026-12-01T03:00:00Z'))).toBe(1)
    // 1 Dec 00:00 New York = 05:00Z; 14 days from 16 Nov 06:00Z is 30 Nov 06:00Z (short), 15 covers it.
    expect(openWeekExpiresInDays(PROMO, NY, at('2026-11-16T06:00:00Z'))).toBe(15)
  })
})
