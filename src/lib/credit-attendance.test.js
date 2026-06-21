import { describe, it, expect } from 'vitest'
import { dedupeKey, filterUncredited } from './credit-attendance.js'

describe('dedupeKey', () => {
  it('builds `${contactId}|${eventId}`', () => {
    expect(dedupeKey({ contact_id: 'c1', glofox_event_id: 'e1' })).toBe('c1|e1')
  })

  it('returns null when contact_id is missing', () => {
    expect(dedupeKey({ glofox_event_id: 'e1' })).toBeNull()
    expect(dedupeKey({ contact_id: null, glofox_event_id: 'e1' })).toBeNull()
  })

  it('returns null when glofox_event_id is missing', () => {
    expect(dedupeKey({ contact_id: 'c1' })).toBeNull()
    expect(dedupeKey({ contact_id: 'c1', glofox_event_id: null })).toBeNull()
  })

  it('returns null for nullish input', () => {
    expect(dedupeKey(null)).toBeNull()
    expect(dedupeKey(undefined)).toBeNull()
  })
})

describe('filterUncredited', () => {
  it('skips bookings whose key already has a session', () => {
    const bookings = [
      { contact_id: 'c1', glofox_event_id: 'e1' }, // already credited → skip
      { contact_id: 'c2', glofox_event_id: 'e1' }, // new → keep
    ]
    const existing = new Set(['c1|e1'])
    const out = filterUncredited(bookings, existing)
    expect(out).toEqual([{ contact_id: 'c2', glofox_event_id: 'e1' }])
  })

  it('dedupes duplicate (contact, class) rows within a page — first wins', () => {
    const bookings = [
      { contact_id: 'c1', glofox_event_id: 'e1', glofox_booking_id: 'b1' },
      { contact_id: 'c1', glofox_event_id: 'e1', glofox_booking_id: 'b2' },
    ]
    const out = filterUncredited(bookings, new Set())
    expect(out).toHaveLength(1)
    expect(out[0].glofox_booking_id).toBe('b1')
  })

  it('drops bookings that cannot be keyed (missing contact/event)', () => {
    const bookings = [
      { contact_id: null, glofox_event_id: 'e1' },
      { contact_id: 'c1', glofox_event_id: null },
      { contact_id: 'c2', glofox_event_id: 'e2' }, // the only valid one
    ]
    const out = filterUncredited(bookings, new Set())
    expect(out).toEqual([{ contact_id: 'c2', glofox_event_id: 'e2' }])
  })

  it('keeps the same member in two different classes', () => {
    const bookings = [
      { contact_id: 'c1', glofox_event_id: 'e1' },
      { contact_id: 'c1', glofox_event_id: 'e2' },
    ]
    const out = filterUncredited(bookings, new Set())
    expect(out).toHaveLength(2)
  })

  it('handles empty / nullish inputs', () => {
    expect(filterUncredited([], new Set())).toEqual([])
    expect(filterUncredited(null, new Set())).toEqual([])
    expect(filterUncredited(undefined, undefined)).toEqual([])
  })
})
