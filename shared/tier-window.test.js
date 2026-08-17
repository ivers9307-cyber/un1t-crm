import { describe, it, expect } from 'vitest'
import { windowMonthKeys, monthsHitInWindow, resolveTierMonths } from './tier-window.js'
import { tierForMonths } from './tiers.js'

// Reference instants (all mid-month, mid-day so Dublin month = UTC month).
const JUN_2026 = new Date('2026-06-15T12:00:00Z').getTime() // Dublin '2026-06'
const JAN_2026 = new Date('2026-01-15T12:00:00Z').getTime() // Dublin '2026-01'

describe('windowMonthKeys', () => {
  it('N=6 returns the current + previous 5 Dublin months, inclusive', () => {
    const keys = windowMonthKeys(6, JUN_2026)
    expect([...keys].sort()).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'])
  })

  it('N=1 returns only the current Dublin month', () => {
    expect([...windowMonthKeys(1, JUN_2026)]).toEqual(['2026-06'])
  })

  it('crosses the year boundary correctly', () => {
    const keys = windowMonthKeys(3, JAN_2026)
    expect([...keys].sort()).toEqual(['2025-11', '2025-12', '2026-01'])
  })

  it('returns empty set for invalid / non-positive N', () => {
    for (const bad of [0, -1, null, undefined, NaN, 'x']) {
      expect(windowMonthKeys(bad, JUN_2026).size).toBe(0)
    }
  })

  it('truncates a fractional N', () => {
    expect(windowMonthKeys(2.9, JUN_2026).size).toBe(2)
  })

  it('uses Europe/Dublin month boundaries (DST): a session-time instant near midnight buckets by Dublin', () => {
    // 2026-06-01T00:30 Dublin (IST, UTC+1) = 2026-05-31T23:30 UTC. Dublin month = June.
    const dublinJun1Early = new Date('2026-05-31T23:30:00Z').getTime()
    expect([...windowMonthKeys(1, dublinJun1Early)]).toEqual(['2026-06'])
    // Same UTC calendar day but 00:30 UTC = 01:30 Dublin, still June.
    const utcMay31LateGmt = new Date('2026-01-31T23:30:00Z').getTime() // GMT (UTC+0) → Dublin Jan 31
    expect([...windowMonthKeys(1, utcMay31LateGmt)]).toEqual(['2026-01'])
  })
})

describe('monthsHitInWindow', () => {
  it('counts only hit-months inside the window (10 total, 2 in last 6)', () => {
    // Member hit Jan..Aug 2025 (8) + May, Jun 2026 (2) = 10 total. Window N=6 @ Jun2026.
    const hits = [
      '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08',
      '2026-05', '2026-06',
    ]
    expect(monthsHitInWindow(hits, 6, JUN_2026)).toBe(2)
    // Feed that count to the ladder: 2 months → below Silver(3), Bronze(1).
    expect(tierForMonths(monthsHitInWindow(hits, 6, JUN_2026)).slug).toBe('bronze')
  })

  it('empty history → 0', () => {
    expect(monthsHitInWindow([], 6, JUN_2026)).toBe(0)
    expect(monthsHitInWindow(null, 6, JUN_2026)).toBe(0)
  })

  it('all history inside window → full count', () => {
    const hits = ['2026-04', '2026-05', '2026-06']
    expect(monthsHitInWindow(hits, 6, JUN_2026)).toBe(3)
  })

  it('collapses duplicate hit-month keys (distinct months only)', () => {
    const hits = ['2026-06', '2026-06', '2026-05']
    expect(monthsHitInWindow(hits, 6, JUN_2026)).toBe(2)
  })

  it('ignores months outside the window even if adjacent (window is exclusive of month N+1 back)', () => {
    // N=6 @ Jun2026 → window is Jan..Jun 2026. Dec 2025 is just outside.
    expect(monthsHitInWindow(['2025-12'], 6, JUN_2026)).toBe(0)
    expect(monthsHitInWindow(['2026-01'], 6, JUN_2026)).toBe(1)
  })

  it('year-boundary window counts correctly', () => {
    const hits = ['2025-11', '2025-12', '2026-01', '2024-01']
    expect(monthsHitInWindow(hits, 3, JAN_2026)).toBe(3) // Nov, Dec, Jan; 2024-01 excluded
  })
})

describe('resolveTierMonths — DEFAULT-OFF (no decay) equals today', () => {
  it('windowMonths absent → cumulative count unchanged', () => {
    expect(resolveTierMonths({ cumulativeMonths: 10 })).toBe(10)
  })
  it('windowMonths null → cumulative', () => {
    expect(resolveTierMonths({ cumulativeMonths: 7, windowMonths: null })).toBe(7)
  })
  it('windowMonths undefined → cumulative, ignoring history', () => {
    const hits = ['2026-06']
    expect(resolveTierMonths({ hitMonthKeys: hits, cumulativeMonths: 24, windowMonths: undefined, nowMs: JUN_2026 })).toBe(24)
  })
  it('windowMonths < 1 or non-numeric → cumulative (never decays)', () => {
    for (const bad of [0, -3, NaN, 'nope']) {
      expect(resolveTierMonths({ cumulativeMonths: 12, windowMonths: bad })).toBe(12)
    }
  })
  it('default-off produces byte-identical tier to a raw cumulative count across the ladder', () => {
    for (const n of [0, 1, 2, 3, 5, 6, 11, 12, 23, 24, 40]) {
      const off = resolveTierMonths({ cumulativeMonths: n }) // decay off
      expect(off).toBe(n)
      expect(tierForMonths(off)).toBe(tierForMonths(n))
    }
  })
})

describe('resolveTierMonths — DECAY ON', () => {
  it('N=6: 10 months total but 2 in window → count is 2 (tier drops to Bronze)', () => {
    const hits = [
      '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08',
      '2026-05', '2026-06',
    ]
    const resolved = resolveTierMonths({ hitMonthKeys: hits, cumulativeMonths: hits.length, windowMonths: 6, nowMs: JUN_2026 })
    expect(resolved).toBe(2)
    // Cumulative would have been Silver (>=3); decayed is Bronze.
    expect(tierForMonths(hits.length).slug).toBe('gold') // 10 → Gold cumulatively
    expect(tierForMonths(resolved).slug).toBe('bronze')
  })

  it('N=6: a consistent member (hit every month in window) keeps a full count', () => {
    const hits = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']
    expect(resolveTierMonths({ hitMonthKeys: hits, cumulativeMonths: 6, windowMonths: 6, nowMs: JUN_2026 })).toBe(6)
  })

  it('N=6: empty history → 0 even though decay is on', () => {
    expect(resolveTierMonths({ hitMonthKeys: [], cumulativeMonths: 0, windowMonths: 6, nowMs: JUN_2026 })).toBe(0)
  })

  it('fractional windowMonths truncates (6.9 → 6)', () => {
    const hits = ['2026-01', '2025-12'] // Jan is in a 6-window @ Jun; Dec 2025 is not
    expect(resolveTierMonths({ hitMonthKeys: hits, cumulativeMonths: 2, windowMonths: 6.9, nowMs: JUN_2026 })).toBe(1)
  })

  it('windowed count is never affected by the passed cumulativeMonths', () => {
    const hits = ['2026-06']
    // cumulative wildly wrong; decay path ignores it entirely.
    expect(resolveTierMonths({ hitMonthKeys: hits, cumulativeMonths: 999, windowMonths: 6, nowMs: JUN_2026 })).toBe(1)
  })
})
