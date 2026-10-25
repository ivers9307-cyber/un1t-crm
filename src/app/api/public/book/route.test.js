// BOOKINGSELF.1 — POST /api/public/book judges the requested time with
// findBookableSlot, the one check the customer reschedule shares: a time the
// widget would not offer (off the grid, outside the window, past
// max_advance_days, taken) is a 409 with nothing inserted, and an unreadable
// occupancy read is a 500, never "free". Before it the route checked only
// the overlap.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'

let tables
let bookingsReadError = null
vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(() => {
    const db = makeFakeDb(tables)
    return {
      from(t) {
        const b = db.from(t)
        if (t === 'bookings' && bookingsReadError) {
          const orig = b.then
          b.then = (res, rej) => orig(() => res({ data: null, error: bookingsReadError }), rej)
        }
        return b
      },
    }
  }),
}))
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 4, resetAt: new Date(), retryAfterSec: 1 })),
}))

const { POST } = await import('./route.js')

const ET_ID = 'e0000000-0000-0000-0000-000000000001'
const WEEK = { start: '09:00', end: '12:00' }
const req = (body) => new Request('http://localhost/api/public/book', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify(body),
})
const body = (over = {}) => ({ event_type_id: ET_ID, booking_date: '2026-10-21', start_time: '10:00', customer_name: 'Sam', customer_email: 'sam@example.com', ...over })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T08:00:00Z'))
  bookingsReadError = null
  tables = {
    event_types: [{
      id: ET_ID, name: 'Consultation', duration_minutes: 30, buffer_minutes: 0, max_advance_days: 10, custom_fields: [],
      create_in_glofox: false, location_id: 'L1', availability: { mon: WEEK, tue: WEEK, wed: WEEK, thu: WEEK, fri: WEEK },
      locations: { timezone: 'Europe/Dublin' },
    }],
    bookings: [{ id: 'other', event_type_id: ET_ID, booking_date: '2026-10-21', start_time: '11:00:00', end_time: '11:30:00', status: 'confirmed' }],
    blocked_times: [],
  }
})
afterEach(() => { vi.useRealTimers() })

describe('POST /api/public/book — the slot check', () => {
  it.each([
    ['off the grid', { start_time: '10:10' }],
    ['outside the window', { start_time: '12:00' }],
    ['a weekend', { booking_date: '2026-10-17' }],
    ['beyond max_advance_days', { booking_date: '2026-10-30' }],
    ['in the past', { booking_date: '2026-10-14' }],
    ['already taken', { start_time: '11:00' }],
  ])('%s is a 409 and nothing is inserted', async (_w, over) => {
    const res = await POST(req(body(over)))
    expect(res.status).toBe(409)
    expect(tables.bookings).toHaveLength(1)
  })

  it('an unreadable occupancy read is a 500, never "free"', async () => {
    bookingsReadError = { message: 'down' }
    const res = await POST(req(body()))
    expect(res.status).toBe(500)
    expect(tables.bookings).toHaveLength(1)
  })
})
