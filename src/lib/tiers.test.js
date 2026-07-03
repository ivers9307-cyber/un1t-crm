import { describe, it, expect } from 'vitest'
import {
  TIERS, tierForMonths, nextTier,
  tierWindowMonths, shiftMonthKey, windowedMonthsHit,
} from './tiers.js'
import { dublinMonthStr } from './dublin-time.js'

describe('TIERS', () => {
  it('is the 5-rung ladder with metal colours', () => {
    expect(TIERS.map((t) => [t.slug, t.months])).toEqual([
      ['bronze', 1], ['silver', 3], ['gold', 6], ['platinum', 12], ['elite', 24],
    ])
    expect(TIERS.find((t) => t.slug === 'gold').color).toBe('#e8b931')
  })
})

describe('tierForMonths', () => {
  it('is null below Bronze', () => { expect(tierForMonths(0)).toBeNull() })
  it('maps counts to the highest reached tier', () => {
    expect(tierForMonths(1).slug).toBe('bronze')
    expect(tierForMonths(2).slug).toBe('bronze')
    expect(tierForMonths(3).slug).toBe('silver')
    expect(tierForMonths(6).slug).toBe('gold')
    expect(tierForMonths(11).slug).toBe('gold')
    expect(tierForMonths(12).slug).toBe('platinum')
    expect(tierForMonths(24).slug).toBe('elite')
    expect(tierForMonths(100).slug).toBe('elite')
  })
})

describe('nextTier', () => {
  it('points at the next rung, null at the top', () => {
    expect(nextTier(0).slug).toBe('bronze')
    expect(nextTier(1).slug).toBe('silver')
    expect(nextTier(3).slug).toBe('gold')
    expect(nextTier(6).slug).toBe('platinum')
    expect(nextTier(12).slug).toBe('elite')
    expect(nextTier(24)).toBeNull()
    expect(nextTier(100)).toBeNull()
  })
})

describe('tierWindowMonths (config coercion)', () => {
  it('absent / null → null (no decay)', () => {
    expect(tierWindowMonths({})).toBeNull()
    expect(tierWindowMonths({ settings: {} })).toBeNull()
    expect(tierWindowMonths({ settings: { scoring: {} } })).toBeNull()
    expect(tierWindowMonths({ settings: { scoring: { tier_window_months: null } } })).toBeNull()
  })
  it('positive integer → that number', () => {
    expect(tierWindowMonths({ settings: { scoring: { tier_window_months: 6 } } })).toBe(6)
    expect(tierWindowMonths({ settings: { scoring: { tier_window_months: 1 } } })).toBe(1)
  })
  it('0 / negative / non-integer → null (treated as no decay)', () => {
    expect(tierWindowMonths({ settings: { scoring: { tier_window_months: 0 } } })).toBeNull()
    expect(tierWindowMonths({ settings: { scoring: { tier_window_months: -6 } } })).toBeNull()
    expect(tierWindowMonths({ settings: { scoring: { tier_window_months: 6.5 } } })).toBeNull()
  })
})

describe('shiftMonthKey', () => {
  it('subtracts across a year boundary', () => {
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12')
    expect(shiftMonthKey('2026-01', -3)).toBe('2025-10')
    expect(shiftMonthKey('2026-07', -6)).toBe('2026-01')
    expect(shiftMonthKey('2026-07', -11)).toBe('2025-08')
  })
  it('adds across a year boundary', () => {
    expect(shiftMonthKey('2025-11', 3)).toBe('2026-02')
  })
  it('identity at delta 0', () => {
    expect(shiftMonthKey('2026-07', 0)).toBe('2026-07')
  })
})

describe('windowedMonthsHit', () => {
  const banked = ['2025-08', '2025-09', '2025-11', '2026-01', '2026-03', '2026-07']

  it('N absent/null → cumulative all-time count (DEFAULT-OFF = unchanged)', () => {
    expect(windowedMonthsHit(banked, null, '2026-07')).toBe(6)
    expect(windowedMonthsHit(banked, undefined, '2026-07')).toBe(6)
    // nowMonth is irrelevant when there's no window
    expect(windowedMonthsHit(banked, null, '2099-01')).toBe(6)
  })

  it('N=6 counts only the last 6 months inclusive of the current month', () => {
    // window for now=2026-07, N=6 → [2026-02 .. 2026-07]
    // banked in window: 2026-03, 2026-07 → 2
    expect(windowedMonthsHit(banked, 6, '2026-07')).toBe(2)
  })

  it('N=12 widens the window', () => {
    // window [2025-08 .. 2026-07] → all 6 qualify
    expect(windowedMonthsHit(banked, 12, '2026-07')).toBe(6)
  })

  it('N=1 counts only the current month', () => {
    expect(windowedMonthsHit(banked, 1, '2026-07')).toBe(1)   // 2026-07 present
    expect(windowedMonthsHit(banked, 1, '2026-06')).toBe(0)   // nothing in 2026-06
  })

  it('excludes future months beyond the current one', () => {
    expect(windowedMonthsHit(['2026-08'], 6, '2026-07')).toBe(0)
  })

  it('windows correctly across a year boundary', () => {
    // now=2026-01, N=6 → [2025-08 .. 2026-01]
    // banked in window: 2025-08, 2025-09, 2025-11, 2026-01 → 4
    expect(windowedMonthsHit(banked, 6, '2026-01')).toBe(4)
  })

  it('de-dupes repeated month keys', () => {
    expect(windowedMonthsHit(['2026-07', '2026-07', '2026-06'], 6, '2026-07')).toBe(2)
  })

  it('ignores malformed period keys', () => {
    expect(windowedMonthsHit(['2026-07', 'garbage', null, '2026', undefined], 6, '2026-07')).toBe(1)
  })

  it('empty history → 0 under any config', () => {
    expect(windowedMonthsHit([], null, '2026-07')).toBe(0)
    expect(windowedMonthsHit([], 6, '2026-07')).toBe(0)
  })
})

describe('windowedMonthsHit — Dublin month boundary (BST/DST)', () => {
  // The only TZ-sensitive input is nowMonth. Derive it via dublinMonthStr so a
  // late-evening instant near a month boundary buckets to the Dublin month, not
  // the UTC month. During BST (Dublin = UTC+1), 23:30 on the 31st Dublin is
  // 22:30 UTC same day — same month either way; the hazard is the flip case.
  it('23:30 Dublin on 30 Jun (BST) is June, not July', () => {
    // 2026-06-30 23:30 Dublin = 2026-06-30 22:30 UTC → both June, but assert
    // the Dublin derivation lands on 2026-06.
    const instant = Date.UTC(2026, 5, 30, 22, 30) // 22:30 UTC
    expect(dublinMonthStr(instant)).toBe('2026-06')
  })
  it('00:30 Dublin on 1 Jul (BST) is July even though it is still June in UTC', () => {
    // 2026-07-01 00:30 Dublin = 2026-06-30 23:30 UTC. UTC month would say June;
    // Dublin says July — this is exactly the case a UTC month would mis-bucket.
    const instant = Date.UTC(2026, 5, 30, 23, 30)
    expect(dublinMonthStr(instant)).toBe('2026-07')
    // and the window math keys off the Dublin month
    const banked = ['2026-07']
    expect(windowedMonthsHit(banked, 1, dublinMonthStr(instant))).toBe(1)
  })
  it('winter (GMT, Dublin=UTC) month boundary is stable', () => {
    const instant = Date.UTC(2026, 0, 31, 23, 30) // 31 Jan 23:30 UTC = same Dublin
    expect(dublinMonthStr(instant)).toBe('2026-01')
  })
})
