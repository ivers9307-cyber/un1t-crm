// HOLDPLACES.1 — places promised to bookings the platform count does not show yet.
import { describe, it, expect } from 'vitest'
import { createFakeDb } from '../../tests/helpers/fake-db'
import { readHeldPlaces, heldPlacesFor } from './class-places-held'

const NOW = Date.parse('2026-11-23T21:06:40Z')
const iso = (ms) => new Date(ms).toISOString()
const MIN = 60_000
const req = (over) => ({
  id: crypto.randomUUID(), location_id: 'HATCH', glofox_event_id: 'un1t:drive', status: 'queued',
  starts_at: iso(NOW + 48 * 60 * MIN), created_at: iso(NOW - MIN), updated_at: iso(NOW - MIN), ...over,
})

describe('readHeldPlaces', () => {
  it('counts queued and processing requests per class, for this studio and classes not yet run', async () => {
    const db = createFakeDb({ tables: { class_booking_requests: [
      req({}), req({ status: 'processing' }),
      req({ glofox_event_id: 'un1t:set' }),
      req({ status: 'failed' }), req({ status: 'needs_review' }), req({ status: 'booked' }),
      req({ location_id: 'OTHER' }),
      req({ starts_at: iso(NOW - MIN) }),
    ] } })
    const held = await readHeldPlaces(db, 'HATCH', { nowMs: NOW })
    expect(heldPlacesFor(held, 'un1t:drive')).toBe(2)
    expect(heldPlacesFor(held, 'un1t:set')).toBe(1)
    expect(heldPlacesFor(held, 'un1t:other')).toBe(0)
  })

  it('a mirror also counts a booking made since the class row was synced', async () => {
    const db = createFakeDb({ tables: { class_booking_requests: [
      req({ status: 'booked', updated_at: iso(NOW - 2 * MIN) }),
      req({ status: 'booked', updated_at: iso(NOW - 20 * MIN) }),
      req({ status: 'booked', updated_at: iso(NOW - 3 * 60 * MIN) }),
    ] } })
    const held = await readHeldPlaces(db, 'HATCH', { nowMs: NOW, withRecent: true })
    // Synced 10 minutes ago: only the booking 2 minutes ago is missing from the count.
    expect(heldPlacesFor(held, 'un1t:drive', iso(NOW - 10 * MIN))).toBe(1)
    // No sync stamp: every recent booking counts; the 3-hour-old one never does.
    expect(heldPlacesFor(held, 'un1t:drive', null)).toBe(2)
    // A live read (no syncedAt given) ignores recent bookings.
    expect(heldPlacesFor(held, 'un1t:drive')).toBe(0)
  })

  it('an unreadable queue holds nothing', async () => {
    const db = createFakeDb({ tables: { class_booking_requests: [req({})] }, errors: { class_booking_requests: { select: { message: 'boom' } } } })
    const held = await readHeldPlaces(db, 'HATCH', { nowMs: NOW })
    expect(heldPlacesFor(held, 'un1t:drive')).toBe(0)
    const thrown = await readHeldPlaces({ from() { throw new Error('down') } }, 'HATCH', { nowMs: NOW })
    expect(heldPlacesFor(thrown, 'un1t:drive')).toBe(0)
  })
})
