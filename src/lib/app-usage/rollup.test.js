import { describe, it, expect } from 'vitest'
import { unionMs, splitByDay, buildDailyRows, rebuildDays, NIL_UUID, RETENTION } from './rollup.js'

const TZ = 'Europe/Dublin'
const MIN = 60_000
// 26 Oct 2026 is after the clocks went back (25 Oct): Dublin = UTC+0.
const at = (h, m = 0, day = 26) => Date.UTC(2026, 9, day, h, m)
const iso = (ms) => new Date(ms).toISOString()

describe('unionMs', () => {
  it('merges overlapping spans', () => {
    expect(unionMs([[0, 10], [5, 20], [30, 40]])).toBe(30)
  })
  it('handles touching, nested and empty input', () => {
    expect(unionMs([[0, 10], [10, 20]])).toBe(20)
    expect(unionMs([[0, 100], [10, 20]])).toBe(100)
    expect(unionMs([])).toBe(0)
  })
})

describe('splitByDay', () => {
  it('splits a span across local midnight', () => {
    const parts = splitByDay(at(23, 50), at(0, 20, 27), TZ)
    expect(parts.map((p) => [p.day, (p.endMs - p.startMs) / MIN])).toEqual([
      ['2026-10-26', 10],
      ['2026-10-27', 20],
    ])
  })
  it('splits on local midnight in summer time, not UTC', () => {
    // 1 Jul: Dublin = UTC+1, so local midnight is 23:00 UTC.
    const s = Date.UTC(2026, 6, 1, 22, 30)
    const e = Date.UTC(2026, 6, 1, 23, 30)
    expect(splitByDay(s, e, TZ).map((p) => p.day)).toEqual(['2026-07-01', '2026-07-02'])
  })
  it('keeps a span inside one day whole', () => {
    expect(splitByDay(at(9), at(10), TZ)).toEqual([{ day: '2026-10-26', startMs: at(9), endMs: at(10) }])
  })
})

const zoneFor = () => TZ
const session = (id, platform, start, end, extra = {}) => ({
  id, profile_id: 'p1', location_id: 'loc1', platform, started_at: iso(start), ended_at: iso(end), ...extra,
})
const visit = (id, sessionId, feature, start, end) => ({
  id, session_id: sessionId, profile_id: 'p1', feature, started_at: iso(start), ended_at: iso(end),
})
const pick = (rows, f) => rows.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v))

describe('buildDailyRows', () => {
  it('counts phone and web separately and their union once', () => {
    const rows = buildDailyRows({
      sessions: [session('s1', 'phone', at(10), at(11)), session('s2', 'web', at(10, 30), at(11, 30))],
      visits: [],
      zoneFor,
    })
    const s = (platform) => pick(rows, { feature: '_session', platform })[0]
    expect(s('phone')).toMatchObject({ seconds: 3600, visits: 1, day: '2026-10-26', location_key: 'loc1' })
    expect(s('web')).toMatchObject({ seconds: 3600, visits: 1 })
    expect(s('all')).toMatchObject({ seconds: 5400, visits: 2 })
  })

  it('does not double count two overlapping browser sessions', () => {
    const rows = buildDailyRows({
      sessions: [session('a', 'web', at(9), at(10)), session('b', 'web', at(9), at(10))],
      visits: [],
      zoneFor,
    })
    expect(pick(rows, { feature: '_session', platform: 'web' })[0].seconds).toBe(3600)
  })

  it('sums visits per feature and counts them', () => {
    const rows = buildDailyRows({
      sessions: [session('s1', 'web', at(9), at(10))],
      visits: [visit('v1', 's1', 'contacts', at(9), at(9, 10)), visit('v2', 's1', 'contacts', at(9, 30), at(9, 35)), visit('v3', 's1', 'inbox', at(9, 10), at(9, 30))],
      zoneFor,
    })
    expect(pick(rows, { feature: 'contacts', platform: 'web' })[0]).toMatchObject({ visits: 2, seconds: 900 })
    expect(pick(rows, { feature: 'inbox', platform: 'web' })[0]).toMatchObject({ visits: 1, seconds: 1200 })
    expect(pick(rows, { feature: 'contacts', platform: 'all' })).toEqual([])
  })

  it('keeps a row per studio for one person on one day', () => {
    const rows = buildDailyRows({
      sessions: [session('s1', 'phone', at(9), at(10)), session('s2', 'phone', at(14), at(15), { location_id: 'loc2' })],
      visits: [],
      zoneFor,
    })
    expect(pick(rows, { feature: '_session', platform: 'phone' }).map((r) => r.location_key).sort()).toEqual(['loc1', 'loc2'])
  })

  it('files a session with no studio under the nil uuid', () => {
    const rows = buildDailyRows({ sessions: [session('s1', 'web', at(9), at(10), { location_id: null })], visits: [], zoneFor })
    expect(rows[0]).toMatchObject({ location_id: null, location_key: NIL_UUID })
  })

  it('splits a session and its visit across midnight', () => {
    const rows = buildDailyRows({
      sessions: [session('s1', 'web', at(23, 50), at(0, 20, 27))],
      visits: [visit('v1', 's1', 'contacts', at(23, 50), at(0, 20, 27))],
      zoneFor,
    })
    expect(pick(rows, { feature: 'contacts' }).map((r) => [r.day, r.seconds])).toEqual([
      ['2026-10-26', 600],
      ['2026-10-27', 1200],
    ])
  })

  it('ignores a visit whose session is not in the set', () => {
    const rows = buildDailyRows({ sessions: [], visits: [visit('v1', 'gone', 'contacts', at(9), at(10))], zoneFor })
    expect(rows).toEqual([])
  })
})

describe('rebuildDays', () => {
  it('is today and yesterday in each zone', () => {
    expect([...rebuildDays(at(1), [TZ])].sort()).toEqual(['2026-10-25', '2026-10-26'])
  })
})

describe('RETENTION', () => {
  it('keeps raw rows 90 days and daily rows 400', () => {
    expect(RETENTION).toEqual({ rawDays: 90, dailyDays: 400 })
  })
})
