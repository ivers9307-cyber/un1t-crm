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

// VISIT-ORIGIN.1 — the visit origin the form sends is sanitised and stamped
// on the contact (first touch: .is('visit_captured_at', null)).
describe('POST /api/public/class-booking — visit origin', () => {
  const stubFrom = (updates) => (table) => {
    const b = {
      select: () => b, eq: () => b, in: () => b, limit: () => b,
      is: (col) => { b._is = col; return b },
      update: (patch) => { updates.push({ table, patch, b }); return b },
      insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'cbr-1', class_name: 'Strength' }, error: null }) }) }),
      maybeSingle: async () => (table === 'landing_page_settings'
        ? { data: { location_id: 'L1', blocks: [{ type: 'class_funnel' }] }, error: null }
        : { data: null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
    }
    return b
  }
  it('stamps the sanitised referrer and landing path on the contact, once', async () => {
    const updates = []
    const spy = vi.spyOn(db, 'from').mockImplementation(stubFrom(updates))
    try {
      await POST(new Request('http://localhost/api/public/class-booking', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: 'hatch-street', event_id: 'ev-1', first_name: 'Sam', last_name: 'Byrne',
          email: 'sam@example.com', phone: '0871234567', consent: true,
          visit: { referrer: 'https://l.instagram.com/?u=x', landing_path: '/hatch-street?utm_campaign=y' },
        }),
      }))
    } finally { spy.mockRestore() }
    const stamp = updates.find((u) => u.table === 'contacts' && u.patch.visit_referrer !== undefined)
    expect(stamp).toBeTruthy()
    expect(stamp.patch).toMatchObject({ visit_referrer: 'https://l.instagram.com', visit_landing_path: '/hatch-street' })
    expect(typeof stamp.patch.visit_captured_at).toBe('string')
    expect(stamp.b._is).toBe('visit_captured_at')
  })
  it('a submission without a visit stamps nothing', async () => {
    const updates = []
    const spy = vi.spyOn(db, 'from').mockImplementation(stubFrom(updates))
    try { await book(undefined) } finally { spy.mockRestore() }
    expect(updates.some((u) => u.table === 'contacts' && u.patch.visit_referrer !== undefined)).toBe(false)
  })
})

// MATCHQUALITY.1 — the Lead carries the form's name, our contact id and the
// Pixel's browser id when the form had it.
describe('POST /api/public/class-booking — match-quality identifiers on the Lead', () => {
  it('passes first name, last name, the contact id and fbp to the Lead', async () => {
    await book({ fbp: 'fb.1.1759600000000.1234567890' })
    const args = sendWebsiteConversion.mock.calls[0][1]
    expect(args).toMatchObject({ firstName: 'Sam', lastName: 'Byrne', externalId: 'c1', fbp: 'fb.1.1759600000000.1234567890' })
  })
  it('an organic visitor with no cookie still sends name and contact id, fbp undefined', async () => {
    await book(undefined)
    const args = sendWebsiteConversion.mock.calls[0][1]
    expect(args).toMatchObject({ firstName: 'Sam', lastName: 'Byrne', externalId: 'c1' })
    expect(args.fbp).toBeUndefined()
  })
})

// BROWSERLEAD.1 — the server Lead carries the browser's event id when the
// form sent one, so the Pixel's Lead and this one dedupe at Meta.
describe('POST /api/public/class-booking — shared event id with the browser Lead', () => {
  it('uses lead_event_id as the CAPI event id', async () => {
    await POST(new Request('http://localhost/api/public/class-booking', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'hatch-street', event_id: 'ev-1', first_name: 'Sam', last_name: 'Byrne',
        email: 'sam@example.com', phone: '0871234567', consent: true,
        lead_event_id: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      }),
    }))
    expect(sendWebsiteConversion.mock.calls[0][1].eventId).toBe('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b')
  })
  it('falls back to the contact + class key when the form sent none', async () => {
    await book(undefined)
    expect(sendWebsiteConversion.mock.calls[0][1].eventId).toBe('classlead-c1-ev-1')
  })
  it('rejects a malformed id instead of forwarding it', async () => {
    const res = await POST(new Request('http://localhost/api/public/class-booking', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'hatch-street', event_id: 'ev-1', first_name: 'Sam', last_name: 'Byrne',
        email: 'sam@example.com', phone: '0871234567', consent: true,
        lead_event_id: '<script>alert(1)</script>',
      }),
    }))
    expect(res.status).toBe(400)
    expect(sendWebsiteConversion).not.toHaveBeenCalled()
  })
})

