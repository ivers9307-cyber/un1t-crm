import { describe, it, expect } from 'vitest'
import {
  eventIsPublic,
  hostEventDefaults,
  computeEditTransition,
  deriveSlug,
  HOST_EVENT_KINDS,
} from './host-events'

describe('eventIsPublic', () => {
  it('is public only when active AND status=published', () => {
    expect(eventIsPublic({ active: true, status: 'published' })).toBe(true)
    expect(eventIsPublic({ active: false, status: 'published' })).toBe(false)
    expect(eventIsPublic({ active: true, status: 'draft' })).toBe(false)
    expect(eventIsPublic({ active: true, status: 'pending_review' })).toBe(false)
    expect(eventIsPublic({ active: true, status: 'rejected' })).toBe(false)
  })
  it('treats a missing status as not public (defensive)', () => {
    expect(eventIsPublic({ active: true })).toBe(false)
    expect(eventIsPublic(null)).toBe(false)
  })
})

describe('hostEventDefaults', () => {
  it('forces safe UN1T-only fields off', () => {
    const d = hostEventDefaults()
    expect(d).toMatchObject({
      member_pricing_enabled: false,
      members_only: false,
      member_fee_cents: null,
      shared: false,
      create_in_glofox: false,
      staff_required: 0,
      payment_currency: 'EUR',
      capacity_mode: 'people',
    })
  })
})

describe('computeEditTransition', () => {
  const published = { status: 'published', race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }] }
  it('keeps published + no re-review for a cosmetic-only edit', () => {
    const t = computeEditTransition(published, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }], description: 'new copy' })
    expect(t).toEqual({ status: 'published', reReview: false })
  })
  it('re-reviews when price changes on a published event', () => {
    const t = computeEditTransition(published, { race_date: '2026-09-01', non_member_fee_cents: 3000, waves: [{ id: 'w1', start_time: '10:00' }] })
    expect(t).toEqual({ status: 'pending_review', reReview: true })
  })
  it('re-reviews when date changes on a published event', () => {
    const t = computeEditTransition(published, { race_date: '2026-09-08', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }] })
    expect(t).toEqual({ status: 'pending_review', reReview: true })
  })
  it('re-reviews when a wave start_time changes on a published event', () => {
    const t = computeEditTransition(published, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '11:00' }] })
    expect(t).toEqual({ status: 'pending_review', reReview: true })
  })
  it('draft/rejected edits never trigger re-review and keep their status', () => {
    expect(computeEditTransition({ status: 'draft', non_member_fee_cents: 2500 }, { non_member_fee_cents: 9999 })).toEqual({ status: 'draft', reReview: false })
    expect(computeEditTransition({ status: 'rejected', non_member_fee_cents: 2500 }, { non_member_fee_cents: 9999 })).toEqual({ status: 'rejected', reReview: false })
  })
})

describe('deriveSlug', () => {
  it('slugifies a name', () => {
    expect(deriveSlug('Summer Throwdown 2026!')).toBe('summer-throwdown-2026')
  })
  it('falls back to a non-empty slug', () => {
    expect(deriveSlug('###')).toBe('event')
    expect(deriveSlug('')).toBe('event')
  })
})

describe('HOST_EVENT_KINDS', () => {
  it('excludes lead_gen (UN1T-only)', () => {
    expect(HOST_EVENT_KINDS).not.toContain('lead_gen')
    expect(HOST_EVENT_KINDS).toContain('workshop')
  })
})
