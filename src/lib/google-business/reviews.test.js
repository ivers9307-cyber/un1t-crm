import { describe, it, expect } from 'vitest'
import { filterVisibleReviews, marqueeDurationSeconds } from './reviews'

describe('filterVisibleReviews', () => {
  const rows = [
    { rating: 5, comment: 'great', hidden: false },
    { rating: 3, comment: 'meh', hidden: false },
    { rating: 5, comment: null, hidden: false },
    { rating: 5, comment: 'hidden one', hidden: true },
    { rating: 4, comment: 'solid', hidden: false },
  ]
  it('keeps only text reviews at/above min rating and not hidden', () => {
    const out = filterVisibleReviews(rows, 4)
    expect(out.map((r) => r.comment)).toEqual(['great', 'solid'])
  })
  it('defaults min rating to 4 when not a number', () => {
    expect(filterVisibleReviews(rows, undefined)).toHaveLength(2)
  })
})

describe('marqueeDurationSeconds', () => {
  it('scales with count and speed', () => {
    expect(marqueeDurationSeconds('normal', 6)).toBe(36)
    expect(marqueeDurationSeconds('slow', 6)).toBe(54)
    expect(marqueeDurationSeconds('fast', 6)).toBe(24)
  })
  it('has a sane floor so a single card still scrolls', () => {
    expect(marqueeDurationSeconds('normal', 1)).toBe(12)
  })
})
