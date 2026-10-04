// METADATASET.1 — POST /api/public/class-booking tells Meta about the captured
// lead with the details that tie it to the ad click: the click id off the
// landing URL (as fbc), the visitor's IP and their browser.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = {
  from(table) {
    const b = {
      select: () => b, eq: () => b, is: () => b, in: () => b, limit: () => b, update: () => b,
      insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'cbr-1', class_name: 'Strength' }, error: null }) }) }),
      maybeSingle: async () => (table === 'landing_page_settings'
        ? { data: { location_id: 'L1', blocks: [{ type: 'class_funnel', event_source_url: 'https://www.un1tdublin.com/start/hatch-street' }] }, error: null }
        : { data: null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
    }
    return b
  },
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/rate-limit', () => ({
  getClientIp: () => '203.0.113.9',
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitResponse: vi.fn(),
}))
vi.mock('@/lib/public-classes', () => ({
  readPublicClasses: vi.fn(async () => ({ classes: [{ event_id: 'ev-1', name: 'Strength', starts_at: '2099-01-01T08:00:00Z' }], error: null })),
}))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: vi.fn(async () => 'c1') }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: vi.fn() }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: vi.fn() }))
vi.mock('@/lib/qstash', () => ({ publishQueuePush: vi.fn(), CLASS_BOOKINGS_WORKER_PATH: '/api/webhooks/qstash/class-bookings' }))
vi.mock('@/lib/waitlist-entry', () => ({ placeWaitlistEntry: vi.fn() }))
vi.mock('@/lib/class-booking-payments', () => ({ createClassBookingPayment: vi.fn() }))
vi.mock('@/lib/location-payments', () => ({ locationCanTakePayments: vi.fn(() => false) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn() }))
vi.mock('@/lib/meta-capi', async (importOriginal) => ({
  ...(await importOriginal()),
  sendWebsiteConversion: vi.fn(async () => ({ sent: true })),
}))

import { POST } from './route.js'
import { sendWebsiteConversion } from '@/lib/meta-capi'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'

const book = (attribution, headers = {}) => POST(new Request('http://localhost/api/public/class-booking', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({
    path: 'hatch-street', event_id: 'ev-1', first_name: 'Sam', last_name: 'Byrne',
    email: 'sam@example.com', phone: '0871234567', consent: true,
    ...(attribution ? { attribution } : {}),
  }),
}))

beforeEach(() => { vi.clearAllMocks() })

// SOURCE-LABEL.1 — a class-booking lead is not a race entrant. The helper's
// INSERT default is source 'race_signup'; this route must override it on
// CREATE (insertFields) so new contacts read 'class_booking'.
describe('POST /api/public/class-booking — new-contact source label', () => {
  it('creates the contact with source class_booking, never the race default', async () => {
    await book(undefined)
    expect(findOrCreateRaceContact).toHaveBeenCalledTimes(1)
    expect(findOrCreateRaceContact.mock.calls[0][0]).toMatchObject({ restrictToOrg: true, insertFields: { source: 'class_booking' } })
  })
})

describe('POST /api/public/class-booking — the Lead event sent to Meta', () => {
  it('carries the ad click id as fbc, the client IP and the user agent', async () => {
    const res = await book({ fbclid: 'IwAR0abc-DEF_123', utm_campaign: 'c' }, { 'user-agent': 'Mozilla/5.0 Test' })
    expect(res.status).toBe(200)
    expect(sendWebsiteConversion).toHaveBeenCalledTimes(1)
    const args = sendWebsiteConversion.mock.calls[0][1]
    expect(args).toMatchObject({
      locationId: 'L1', eventName: 'Lead', email: 'sam@example.com', phone: '0871234567',
      eventSourceUrl: 'https://www.un1tdublin.com/start/hatch-street',
      eventId: 'classlead-c1-ev-1', contentName: 'Strength',
      clientIp: '203.0.113.9', userAgent: 'Mozilla/5.0 Test',
    })
    expect(args.fbc).toMatch(/^fb\.1\.\d+\.IwAR0abc-DEF_123$/)
  })

  it('an organic visitor (no click id) still sends the Lead, with no fbc', async () => {
    await book(undefined, { 'user-agent': 'UA' })
    const args = sendWebsiteConversion.mock.calls[0][1]
    expect(args.fbc).toBeNull()
    expect(args.clientIp).toBe('203.0.113.9')
  })

  it('a malformed click id is dropped, never forwarded', async () => {
    await book({ fbclid: 'not a click id <x>' })
    expect(sendWebsiteConversion.mock.calls[0][1].fbc).toBeNull()
  })
})
