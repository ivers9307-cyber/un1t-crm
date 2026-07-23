import { describe, it, expect } from 'vitest'
import { currentWeekNo, weeksNeedingExpansion } from './expand-plan'

const block = { starts_on: '2026-08-03', weeks: 12 } // Mon

describe('currentWeekNo', () => {
  it('is week 1 in the first 7 days', () => {
    expect(currentWeekNo('2026-08-03', '2026-08-03')).toBe(1)
    expect(currentWeekNo('2026-08-03', '2026-08-09')).toBe(1)
  })
  it('is week 2 on day 8', () => {
    expect(currentWeekNo('2026-08-03', '2026-08-10')).toBe(2)
  })
  it('is null before the start', () => {
    expect(currentWeekNo('2026-08-03', '2026-08-01')).toBeNull()
  })
})

describe('weeksNeedingExpansion', () => {
  it('returns current..+2 weeks that have no sessions yet', () => {
    // current week 3; weeks 1-2 already expanded
    expect(weeksNeedingExpansion(block, [1, 2, 3], '2026-08-17', 2)).toEqual([4, 5])
  })
  it('clamps to block.weeks', () => {
    const b = { starts_on: '2026-08-03', weeks: 12 }
    // near the end: current week 12
    expect(weeksNeedingExpansion(b, [], '2026-10-19', 2)).toEqual([12])
  })
  it('is empty before the block starts', () => {
    expect(weeksNeedingExpansion(block, [], '2026-08-01', 2)).toEqual([])
  })
})
