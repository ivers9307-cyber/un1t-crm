// REGISTRYREAD.1a — POST /api/public/class-booking: a timetable we could not
// read is not "that class is gone". It answered code 'class_unavailable', so
// the funnel told the customer their class "filled up while you were typing"
// and sent them back to an empty picker. Now: 503 'timetable_unavailable', and
// the funnel shows the error with their details intact.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = {
  from(table) {
    const b = {
      select: () => b, eq: () => b, is: () => b, update: () => b,
      maybeSingle: async () => (table === 'landing_page_settings'
        ? { data: { location_id: 'L1', blocks: [] }, error: null }
        : { data: null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
    }
    return b
  },
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/rate-limit', () => ({
  getClientIp: () => '1.2.3.4',
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitResponse: vi.fn(),
}))
vi.mock('@/lib/public-classes', () => ({ readPublicClasses: vi.fn(), listPublicClasses: vi.fn(async () => []) }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: vi.fn(async () => null) }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: vi.fn() }))
vi.mock('@/lib/qstash', () => ({ publishQueuePush: vi.fn(), CLASS_BOOKINGS_WORKER_PATH: '/api/webhooks/qstash/class-bookings' }))
vi.mock('@/lib/waitlist-entry', () => ({ placeWaitlistEntry: vi.fn() }))
vi.mock('@/lib/class-booking-payments', () => ({ createClassBookingPayment: vi.fn() }))
vi.mock('@/lib/location-payments', () => ({ locationCanTakePayments: vi.fn(() => false) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn() }))

import { POST } from './route.js'
import { readPublicClasses } from '@/lib/public-classes'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'

const book = () => POST(new Request('http://localhost/api/public/class-booking', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    path: 'stillorgan', event_id: 'ev-1', first_name: 'Sam', last_name: 'Byrne',
    email: 'sam@example.com', phone: '0871234567', consent: true,
  }),
}))

beforeEach(() => vi.clearAllMocks())

describe('POST /api/public/class-booking — timetable read', () => {
  it('a timetable read failure answers 503 timetable_unavailable and captures nothing', async () => {
    readPublicClasses.mockResolvedValueOnce({ classes: [], error: 'glofox_settings_unreadable' })
    const res = await book()
    expect(res.status).toBe(503)
    const j = await res.json()
    expect(j).toMatchObject({ success: false, code: 'timetable_unavailable' })
    expect(j.error).not.toMatch(/—/) // customer copy: no em-dashes
    expect(findOrCreateRaceContact).not.toHaveBeenCalled()
  })

  it('a class that really is not in the list is still class_unavailable (unchanged)', async () => {
    readPublicClasses.mockResolvedValueOnce({ classes: [{ event_id: 'other', name: 'BASE', starts_at: '2099-01-01T08:00:00Z' }], error: null })
    const res = await book()
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('class_unavailable')
  })

  it('a listed class proceeds to capture the lead', async () => {
    readPublicClasses.mockResolvedValueOnce({ classes: [{ event_id: 'ev-1', name: 'BASE', starts_at: '2099-01-01T08:00:00Z' }], error: null })
    await book()
    expect(findOrCreateRaceContact).toHaveBeenCalledOnce()
  })
})
