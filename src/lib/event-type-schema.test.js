import { describe, it, expect } from 'vitest'
import { EventTypeCreateSchema, EventTypeUpdateSchema } from './event-type-schema'

// BOOKINGWINDOWS.1 — the save routes refuse a schedule the slot engine would
// misread, and still take the legacy single-window shape API clients send.
describe('availability on the booking-type write schemas', () => {
  it('accepts several windows a day, the legacy shape, off days and no availability', () => {
    const availability = {
      mon: [{ start: '07:00', end: '10:00' }, { start: '17:00', end: '20:00' }],
      tue: { start: '09:00', end: '18:00' },
      wed: null,
    }
    expect(EventTypeUpdateSchema.safeParse({ availability }).success).toBe(true)
    expect(EventTypeUpdateSchema.safeParse({}).success).toBe(true)
    expect(EventTypeCreateSchema.safeParse({ name: 'PT', availability: null }).success).toBe(true)
  })

  it('refuses overlapping windows with the day in the message', () => {
    const r = EventTypeUpdateSchema.safeParse({
      availability: { thu: [{ start: '09:00', end: '12:00' }, { start: '11:30', end: '13:00' }] },
    })
    expect(r.success).toBe(false)
    expect(r.error.issues[0].path).toEqual(['availability'])
    expect(r.error.issues[0].message).toBe('Thursday: 09:00–12:00 overlaps 11:30–13:00.')
  })

  it('refuses a window that ends before it starts', () => {
    const r = EventTypeCreateSchema.safeParse({ name: 'PT', availability: { sat: [{ start: '12:00', end: '10:00' }] } })
    expect(r.success).toBe(false)
    expect(r.error.issues[0].message).toMatch(/^Saturday: /)
  })
})
