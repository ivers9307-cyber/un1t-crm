import { describe, it, expect } from 'vitest'
import {
  normalizeStarRating,
  normalizeReview,
  filterVisibleReviews,
  marqueeDurationSeconds,
  fullLocationResource,
} from './reviews'

describe('normalizeStarRating', () => {
  it('maps the Google word enum to 1–5', () => {
    expect(normalizeStarRating('ONE')).toBe(1)
    expect(normalizeStarRating('THREE')).toBe(3)
    expect(normalizeStarRating('FIVE')).toBe(5)
  })
  it('returns 0 for unknown/empty so it is filtered out downstream', () => {
    expect(normalizeStarRating('STAR_RATING_UNSPECIFIED')).toBe(0)
    expect(normalizeStarRating(null)).toBe(0)
  })
})

describe('normalizeReview', () => {
  it('flattens a Google v4 review into our row shape', () => {
    const row = normalizeReview({
      reviewId: 'abc',
      starRating: 'FIVE',
      comment: 'Best gym ever',
      createTime: '2026-05-01T10:00:00Z',
      reviewer: { displayName: 'Aoife M.', profilePhotoUrl: 'http://x/p.jpg' },
      reviewReply: { comment: 'Thanks!' },
    })
    expect(row).toMatchObject({
      google_review_id: 'abc',
      rating: 5,
      comment: 'Best gym ever',
      author_name: 'Aoife M.',
      author_photo_url: 'http://x/p.jpg',
      reply_comment: 'Thanks!',
      review_time: '2026-05-01T10:00:00Z',
    })
  })
  it('tolerates missing reviewer / reply / comment', () => {
    const row = normalizeReview({ reviewId: 'z', starRating: 'FOUR', createTime: '2026-01-01T00:00:00Z' })
    expect(row.rating).toBe(4)
    expect(row.comment).toBeNull()
    expect(row.author_name).toBeNull()
    expect(row.reply_comment).toBeNull()
  })
})

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

describe('fullLocationResource', () => {
  it('joins a short-form location name under the account', () => {
    expect(fullLocationResource('accounts/123', 'locations/456')).toBe('accounts/123/locations/456')
  })
  it('passes through an already-qualified name (no doubling)', () => {
    expect(fullLocationResource('accounts/123', 'accounts/123/locations/456')).toBe('accounts/123/locations/456')
  })
  it('returns null for an empty name', () => {
    expect(fullLocationResource('accounts/123', '')).toBeNull()
  })
})
