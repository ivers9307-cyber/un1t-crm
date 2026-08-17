import { describe, it, expect } from 'vitest'
import { weeklyBuckets, monthlyRecap, personalRecords, activityCalendar } from './progress-analytics.js'

const DAY = 24 * 3600 * 1000
const now = Date.parse('2026-06-21T12:00:00Z')      // a Sunday
const sAt = (daysAgo, over = {}) => ({
  id: `s-${daysAgo}`, started_at: new Date(now - daysAgo * DAY).toISOString(),
  ended_at: new Date(now - daysAgo * DAY + 45 * 60000).toISOString(),
  effort_points: 100, peak_hr_bpm: 170, avg_hr_bpm: 150, zones_seconds: {}, source: 'ble_bridge',
  ...over,
})

describe('weeklyBuckets', () => {
  it('returns exactly `weeks` entries, oldest→newest, empty weeks zeroed', () => {
    const b = weeklyBuckets([sAt(1), sAt(2)], now, 12)
    expect(b).toHaveLength(12)
    expect(b[0].weekStartMs).toBeLessThan(b[11].weekStartMs)
    expect(b[11].count).toBe(2)               // both sessions are in the current week
    expect(b[0].count).toBe(0)
  })
  it('sums points + minutes and averages peak HR per bucket; null peak when none', () => {
    const b = weeklyBuckets([sAt(1, { effort_points: 100, peak_hr_bpm: 160 }), sAt(2, { effort_points: 50, peak_hr_bpm: 180 })], now, 1)
    expect(b[0].points).toBe(150)
    expect(b[0].minutes).toBe(90)
    expect(b[0].avgPeakHr).toBe(170)
    expect(weeklyBuckets([sAt(1, { peak_hr_bpm: null })], now, 1)[0].avgPeakHr).toBeNull()
  })
  it('skips future-dated + unparseable', () => {
    const b = weeklyBuckets([sAt(-3), { started_at: 'nope' }, sAt(1)], now, 1)
    expect(b[0].count).toBe(1)
  })
})

describe('monthlyRecap', () => {
  it('returns `months` entries incl current MTD, oldest→newest', () => {
    const r = monthlyRecap([sAt(1)], now, 6)
    expect(r.months).toHaveLength(6)
    expect(r.months[5].label).toMatch(/Jun 2026/)
    expect(r.months[5].count).toBe(1)
  })
  it('fittest = month with max points across ALL sessions; null when empty', () => {
    const r = monthlyRecap([sAt(40), sAt(41), sAt(42), sAt(1)], now, 6)
    expect(r.fittest.month).toBe(4)           // May = month index 4
    expect(monthlyRecap([], now).fittest).toBeNull()
  })
})

describe('personalRecords', () => {
  it('picks max session points / peak HR / longest, with the session id', () => {
    const r = personalRecords([sAt(1, { effort_points: 100 }), sAt(2, { id: 'big', effort_points: 300, peak_hr_bpm: 190 })])
    expect(r.bestSessionPoints).toEqual({ value: 300, sessionId: 'big', atMs: expect.any(Number) })
    expect(r.highestPeakHr.value).toBe(190)
    expect(r.longestSessionMin.value).toBe(45)
  })
  it('bestWeekPoints sums a week; bestStreak from currentStreak; empty → nulls + 0', () => {
    const r = personalRecords([sAt(1, { effort_points: 100 }), sAt(2, { effort_points: 50 })])
    expect(r.bestWeekPoints.value).toBe(150)
    expect(typeof r.bestStreak).toBe('number')
    const e = personalRecords([])
    expect(e.bestSessionPoints).toBeNull(); expect(e.bestStreak).toBe(0)
  })
})

describe('activityCalendar', () => {
  it('one entry per day in window, counts per day, maxCount, future skipped', () => {
    const c = activityCalendar([sAt(1), sAt(1), sAt(3), sAt(-2)], now, 84)
    expect(c.days).toHaveLength(84)
    expect(c.maxCount).toBe(2)
    // Dublin-bucketed: the last cell is Dublin-midnight of 2026-06-21, which in
    // IST (UTC+1) is 2026-06-20T23:00:00Z — not UTC midnight.
    expect(c.days[c.days.length - 1].dayMs).toBe(Date.parse('2026-06-20T23:00:00Z'))
    expect(c.days[c.days.length - 1].dateKey).toBe('2026-06-21')
  })
  it('buckets a post-midnight BST session on the Dublin day, not the UTC day', () => {
    // 2026-06-21 00:30 Dublin (IST) = 2026-06-20T23:30:00Z. It must light the
    // 2026-06-21 cell (the last one), not 2026-06-20.
    const s = { id: 'late', started_at: '2026-06-20T23:30:00Z', ended_at: '2026-06-20T23:59:00Z', effort_points: 50 }
    const c = activityCalendar([s], Date.parse('2026-06-21T12:00:00Z'), 84)
    expect(c.days[c.days.length - 1].dateKey).toBe('2026-06-21')
    expect(c.days[c.days.length - 1].count).toBe(1)
    expect(c.days[c.days.length - 2].count).toBe(0)
  })
})
