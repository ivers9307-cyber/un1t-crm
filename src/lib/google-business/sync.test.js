import { describe, it, expect } from 'vitest'
import { buildReviewRows } from './sync'

describe('buildReviewRows', () => {
  const locationId = 'loc-1'
  const pages = [
    { reviews: [
      { reviewId: 'a', starRating: 'FIVE', comment: 'great', createTime: '2026-05-02T00:00:00Z', reviewer: { displayName: 'A' } },
      { reviewId: 'b', starRating: 'STAR_RATING_UNSPECIFIED', comment: 'noise', createTime: '2026-05-01T00:00:00Z' },
    ] },
    { reviews: [
      { reviewId: 'c', starRating: 'FOUR', createTime: '2026-04-30T00:00:00Z' },
    ] },
  ]

  it('flattens all pages, drops rating-0 reviews, stamps location_id', () => {
    const rows = buildReviewRows(locationId, pages)
    expect(rows.map((r) => r.google_review_id)).toEqual(['a', 'c'])
    expect(rows.every((r) => r.location_id === locationId)).toBe(true)
    expect(rows.every((r) => typeof r.synced_at === 'string')).toBe(true)
  })

  it('never includes a hidden key (upsert must not reset operator hides)', () => {
    const rows = buildReviewRows(locationId, pages)
    expect(rows.every((r) => !('hidden' in r))).toBe(true)
  })
})
