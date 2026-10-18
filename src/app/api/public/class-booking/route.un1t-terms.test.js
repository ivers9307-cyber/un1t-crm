// UN1TWRITE.18 — POST /api/public/class-booking at a un1t.online studio:
// the terms and waiver tick is required while the funnel is on and recorded
// on the queue row; a stored class_funnel price is ignored there (anything
// paid goes through un1t.online checkout). Glofox and manual studios are
// unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let pageBlocks = []
let locRow = null
let existingRow = null
const inserts = []
const updates = []
const db = {
  from(table) {
    const b = {
      select: () => b, eq: () => b, is: () => b, in: () => b, limit: () => b,
      update: (row) => { updates.push({ table, row }); return b },
      insert: (row) => { inserts.push({ table, row }); return b },
      maybeSingle: async () => {
        if (table === 'landing_page_settings') return { data: { location_id: 'L1', blocks: pageBlocks }, error: null }
        if (table === 'locations') return { data: locRow, error: null }
        if (table === 'class_booking_requests' && existingRow) return { data: existingRow, error: null }
        if (table === 'class_booking_requests' && inserts.some((i) => i.table === table)) return { data: { id: 'Q1', class_name: 'BASE' }, error: null }
        return { data: null, error: null }
      },
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
vi.mock('@/lib/public-classes', () => ({ readPublicClasses: vi.fn(async () => ({ classes: [{ event_id: 'un1t:e-1', name: 'BASE', starts_at: '2099-01-01T08:00:00Z' }], error: null })) }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: vi.fn(async () => 'C1') }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: vi.fn() }))
vi.mock('@/lib/qstash', () => ({ publishQueuePush: vi.fn(), CLASS_BOOKINGS_WORKER_PATH: '/x' }))
vi.mock('@/lib/waitlist-entry', () => ({ placeWaitlistEntry: vi.fn() }))
vi.mock('@/lib/class-booking-payments', () => ({ createClassBookingPayment: vi.fn(async () => ({ paymentId: 'P', checkout: {} })) }))
vi.mock('@/lib/location-payments', () => ({ locationCanTakePayments: vi.fn(() => true) }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: vi.fn() }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: vi.fn(), fbcFromFbclid: () => undefined }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn(), logError: vi.fn() }))
let settings
vi.mock('@/lib/un1t-online-settings', async (importOriginal) => ({
  ...(await importOriginal()),
  readUn1tWriteSettings: vi.fn(async () => settings),
}))
vi.mock('@/lib/un1t-online-legal', () => ({ readUn1tLegalDocs: vi.fn(async () => ({ terms: {}, waiver: {}, version: 'terms:a|waiver:b' })) }))

import { POST } from './route.js'
import { createClassBookingPayment } from '@/lib/class-booking-payments'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { logError } from '@/lib/log'

const un1t = (funnel) => ({
  membershipSource: 'un1t_online', studioName: 'Hatch Street', organizationId: 'O',
  settings: { writesEnabled: funnel, funnelEnabled: funnel, hiddenClassKeywords: [] },
})
const glofox = { membershipSource: 'glofox', studioName: 'Stillorgan', organizationId: 'O', settings: { writesEnabled: false, funnelEnabled: false, hiddenClassKeywords: [] } }

const book = (extra = {}) => POST(new Request('http://localhost/api/public/class-booking', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    path: 'hatch-street', event_id: 'un1t:e-1', first_name: 'Sam', last_name: 'Byrne',
    email: 'sam@example.com', phone: '0871234567', consent: true, ...extra,
  }),
}))
const queued = () => inserts.find((i) => i.table === 'class_booking_requests')?.row

beforeEach(() => {
  vi.clearAllMocks()
  inserts.length = 0
  updates.length = 0
  existingRow = null
  pageBlocks = [{ type: 'class_funnel' }]
  locRow = { id: 'L1', membership_source: 'glofox', settings: {} }
  settings = un1t(true)
})

describe('UN1TWRITE.18 — terms and waiver tick', () => {
  it("funnel on: no tick is a 400 with the default message, and nothing is captured", async () => {
    const res = await book()
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.success).toBe(false)
    expect(j.error).toBe('Please tick to accept the terms and waiver.')
    expect(j.issues.terms_accepted).toBe(j.error)
    // The refusal carries the tick, so a page that did not know can show it.
    expect(j.code).toBe('terms_required')
    expect(j.terms).toMatchObject({ required: true, label: "I accept Hatch Street's {terms} and {waiver}", terms_url: '/legal/un1t/hatch-street/terms', waiver_url: '/legal/un1t/hatch-street/waiver' })
    expect(findOrCreateRaceContact).not.toHaveBeenCalled()
    expect(queued()).toBeUndefined()
  })

  it("funnel on: the operator's message is used", async () => {
    pageBlocks = [{ type: 'class_funnel', terms_required_message: 'Tick the box to go on.' }]
    const j = await (await book({ terms_accepted: false })).json()
    expect(j.error).toBe('Tick the box to go on.')
  })

  it('funnel on: a tick queues the row with terms_accepted_at, source website and the documents version', async () => {
    const res = await book({ terms_accepted: true })
    expect(res.status).toBe(200)
    const row = queued()
    expect(row.terms_source).toBe('website')
    expect(Number.isFinite(Date.parse(row.terms_accepted_at))).toBe(true)
    expect(row.terms_version).toBe('terms:a|waiver:b')
  })

  it('funnel off at a un1t.online studio, or a Glofox studio: no tick needed and no terms columns written', async () => {
    settings = un1t(false)
    expect((await book()).status).toBe(200)
    expect(queued()).not.toHaveProperty('terms_source')
    inserts.length = 0
    settings = glofox
    expect((await book({ terms_accepted: true })).status).toBe(200)
    const row = queued()
    expect(row).not.toHaveProperty('terms_source')
    expect(row).not.toHaveProperty('terms_accepted_at')
    expect(row).not.toHaveProperty('terms_version')
  })

  it('a retry with the tick records it on the row the first try queued without one', async () => {
    existingRow = { id: 'Q0' }
    const res = await book({ terms_accepted: true })
    expect((await res.json()).data).toEqual({ queued: true, deduped: true })
    const u = updates.find((x) => x.table === 'class_booking_requests')
    expect(u.row).toMatchObject({ terms_source: 'website', terms_version: 'terms:a|waiver:b' })
    expect(queued()).toBeUndefined()
  })

  it('an unreadable settings row never blocks a booking (the processor refuses an account without an acceptance)', async () => {
    readUn1tWriteSettings.mockRejectedValueOnce(new Error('db down'))
    const res = await book()
    expect(res.status).toBe(200)
    expect(queued()).not.toHaveProperty('terms_source')
  })
})

describe('UN1TWRITE.18 — a stored price at a un1t.online studio', () => {
  it('books free, never opens a payment, and logs once', async () => {
    pageBlocks = [{ type: 'class_funnel', price_cents: 1500 }]
    locRow = { id: 'L1', membership_source: 'un1t_online', settings: {} }
    const res = await book({ terms_accepted: true })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ queued: true })
    expect(createClassBookingPayment).not.toHaveBeenCalled()
    expect(queued().status).toBe('queued')
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][1]).toBe('class_funnel price ignored at a un1t.online studio')
  })

  it('a Glofox studio still takes the paid path', async () => {
    settings = glofox
    pageBlocks = [{ type: 'class_funnel', price_cents: 1500 }]
    locRow = { id: 'L1', membership_source: 'glofox', settings: {} }
    await book()
    expect(createClassBookingPayment).toHaveBeenCalledOnce()
    expect(queued().status).toBe('awaiting_payment')
  })
})
