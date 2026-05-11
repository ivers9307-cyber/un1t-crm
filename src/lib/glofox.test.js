import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyGlofoxSignature, parseGlofoxEvent, tagsForGlofoxEvent } from './glofox.js'

function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex')
}

describe('verifyGlofoxSignature', () => {
  const secret = 'test-secret-123'
  const body = JSON.stringify({ event_type: 'booking.created', data: { id: 'b1' } })

  it('returns true for a valid signature', () => {
    const sig = sign(secret, body)
    expect(verifyGlofoxSignature({ rawBody: body, signatureHeader: sig, secret })).toBe(true)
  })

  it('returns false for a tampered body', () => {
    const sig = sign(secret, body)
    const tampered = body.replace('b1', 'b2')
    expect(verifyGlofoxSignature({ rawBody: tampered, signatureHeader: sig, secret })).toBe(false)
  })

  it('returns false for a wrong secret', () => {
    const sig = sign('different-secret', body)
    expect(verifyGlofoxSignature({ rawBody: body, signatureHeader: sig, secret })).toBe(false)
  })

  it('returns false for missing arguments', () => {
    expect(verifyGlofoxSignature({ rawBody: body, signatureHeader: '', secret })).toBe(false)
    expect(verifyGlofoxSignature({ rawBody: '', signatureHeader: 'x', secret })).toBe(false)
    expect(verifyGlofoxSignature({ rawBody: body, signatureHeader: 'x', secret: '' })).toBe(false)
  })

  it('returns false for length-mismatch signature (no timingSafeEqual throw)', () => {
    expect(verifyGlofoxSignature({ rawBody: body, signatureHeader: 'short', secret })).toBe(false)
  })

  it('rejects non-string inputs', () => {
    expect(verifyGlofoxSignature({ rawBody: { not: 'a string' }, signatureHeader: 'x', secret })).toBe(false)
    expect(verifyGlofoxSignature({ rawBody: body, signatureHeader: 123, secret })).toBe(false)
  })
})

describe('parseGlofoxEvent', () => {
  it('returns all-nulls for a non-object payload', () => {
    expect(parseGlofoxEvent(null)).toEqual({
      eventId: null, eventType: null, branchId: null, entityId: null, contactEmail: null,
    })
    expect(parseGlofoxEvent('string')).toEqual({
      eventId: null, eventType: null, branchId: null, entityId: null, contactEmail: null,
    })
  })

  it('extracts top-level fields', () => {
    const payload = {
      event_id: 'evt_123',
      event_type: 'booking.created',
      branch_id: 'br1',
      data: { id: 'b1', email: 'me@example.com' },
    }
    expect(parseGlofoxEvent(payload)).toEqual({
      eventId: 'evt_123',
      eventType: 'booking.created',
      branchId: 'br1',
      entityId: 'b1',
      contactEmail: 'me@example.com',
    })
  })

  it('handles camelCase variations', () => {
    const payload = {
      eventId: 'evt_123',
      eventType: 'membership.created',
      branchId: 'br1',
      data: { id: 'm1', email: 'A@B.COM' },
    }
    const out = parseGlofoxEvent(payload)
    expect(out.eventId).toBe('evt_123')
    expect(out.eventType).toBe('membership.created')
    expect(out.branchId).toBe('br1')
    expect(out.entityId).toBe('m1')
    // Email is normalised to lowercase + trimmed
    expect(out.contactEmail).toBe('a@b.com')
  })

  it('falls back through multiple email paths', () => {
    expect(parseGlofoxEvent({ data: { member_email: 'm@x.com' } }).contactEmail).toBe('m@x.com')
    expect(parseGlofoxEvent({ data: { member: { email: 'n@x.com' } } }).contactEmail).toBe('n@x.com')
    expect(parseGlofoxEvent({ data: { user: { email: 'u@x.com' } } }).contactEmail).toBe('u@x.com')
    expect(parseGlofoxEvent({ data: { customer: { email: 'c@x.com' } } }).contactEmail).toBe('c@x.com')
  })

  it('returns null fields when nothing matches', () => {
    const out = parseGlofoxEvent({ random: 'object' })
    expect(out.eventType).toBeNull()
    expect(out.contactEmail).toBeNull()
  })

  it('coerces non-string ids to strings', () => {
    const out = parseGlofoxEvent({ id: 12345, type: 'x' })
    expect(out.eventId).toBe('12345')
  })

  it('treats empty string as missing', () => {
    expect(parseGlofoxEvent({ event_id: '', event_type: 'x' }).eventId).toBeNull()
  })
})

describe('tagsForGlofoxEvent', () => {
  it('maps known event types to one or more tags', () => {
    expect(tagsForGlofoxEvent('booking.created')).toEqual(['glofox_booking_created'])
    expect(tagsForGlofoxEvent('membership.cancelled')).toEqual(['glofox_membership_cancelled'])
    expect(tagsForGlofoxEvent('member.created')).toEqual(['glofox_member_created'])
  })

  it('aliases US-spelt cancellations to the British form', () => {
    expect(tagsForGlofoxEvent('booking.canceled')).toEqual(['glofox_booking_cancelled'])
    expect(tagsForGlofoxEvent('membership.canceled')).toEqual(['glofox_membership_cancelled'])
  })

  it('aliases membership.expired to membership_ended', () => {
    expect(tagsForGlofoxEvent('membership.expired')).toEqual(['glofox_membership_ended'])
  })

  it('returns empty array for unknown event types', () => {
    expect(tagsForGlofoxEvent('something.weird')).toEqual([])
    expect(tagsForGlofoxEvent('')).toEqual([])
    expect(tagsForGlofoxEvent(null)).toEqual([])
    expect(tagsForGlofoxEvent(undefined)).toEqual([])
  })

  it('forgives snake_case + hyphen variants', () => {
    expect(tagsForGlofoxEvent('booking_created')).toEqual(['glofox_booking_created'])
    expect(tagsForGlofoxEvent('booking-created')).toEqual(['glofox_booking_created'])
  })

  it('returns a fresh array per call (caller can mutate without poisoning)', () => {
    const a = tagsForGlofoxEvent('booking.created')
    const b = tagsForGlofoxEvent('booking.created')
    expect(a).not.toBe(b)
    a.push('extra')
    expect(b).toEqual(['glofox_booking_created'])
  })
})
