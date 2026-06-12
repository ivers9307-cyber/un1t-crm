// MOBILE-TODAY-FEED — tests for the feed-row → mobile-route mapping.
// Pure (runs under vitest's node env like the other mobile/lib tests).
// Routes must point at screens that actually exist under mobile/app/;
// rows with no sensible mobile destination map to null and render as
// informational (non-tappable) rows.

import { describe, it, expect } from 'vitest'
import { mobileRouteForFeedRow } from './today-feed-nav'

describe('mobileRouteForFeedRow', () => {
  it('maps rows to their existing mobile screens', () => {
    expect(mobileRouteForFeedRow('approvals')).toBe('/approvals')
    expect(mobileRouteForFeedRow('issues')).toBe('/issues')
    expect(mobileRouteForFeedRow('whatsapp')).toBe('/whatsapp')
    expect(mobileRouteForFeedRow('bookings')).toBe('/bookings')
    expect(mobileRouteForFeedRow('churn')).toBe('/radar')
    expect(mobileRouteForFeedRow('tasks')).toBe('/tasks')
  })

  it('returns null for rows with no mobile destination', () => {
    // The mobile invoices surface is contractor self-service, NOT the
    // operator email-in inbox the feed row counts — wrong target.
    expect(mobileRouteForFeedRow('invoices')).toBe(null)
    // Class booking lives in the web unified inbox only.
    expect(mobileRouteForFeedRow('lowfill')).toBe(null)
    expect(mobileRouteForFeedRow('unknown-future-row')).toBe(null)
    expect(mobileRouteForFeedRow(null)).toBe(null)
  })
})
