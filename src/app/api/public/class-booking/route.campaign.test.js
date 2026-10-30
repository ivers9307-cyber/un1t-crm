// FIFTYPLUS.1 — POST /api/public/class-booking with `campaign`: the row's
// campaign_funnel block for that key decides the tag, lead source, trial pair
// and the allow-listed validation read. No trial pair (or no such block) is
// refused not_configured, never a fallback to the class_funnel block's trial,
// which is the generic one. Without `campaign` the route is unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let pageBlocks = []
let inserted = null
const db = {
  from(table) {
    const b = {
      select: () => b, eq: () => b, is: () => b, in: () => b, limit: () => b, update: () => b,
      insert: (row) => { inserted = row; return { select: () => ({ maybeSingle: async () => ({ data: { id: 'req-1', class_name: row.class_name }, error: null }) }) } },
      maybeSingle: async () => (table === 'landing_page_settings'
        ? { data: { location_id: 'L1', blocks: pageBlocks }, error: null }
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
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: vi.fn() }))
vi.mock('@/lib/qstash', () => ({ publishQueuePush: vi.fn(), CLASS_BOOKINGS_WORKER_PATH: '/api/webhooks/qstash/class-bookings' }))
vi.mock('@/lib/waitlist-entry', () => ({ placeWaitlistEntry: vi.fn() }))
vi.mock('@/lib/class-booking-payments', () => ({ createClassBookingPayment: vi.fn() }))
vi.mock('@/lib/location-payments', () => ({ locationCanTakePayments: vi.fn(() => true) }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: vi.fn(async () => ({ sent: true })), fbcFromFbclid: () => undefined }))
vi.mock('@/lib/un1t-online-settings', () => ({
  readUn1tWriteSettings: vi.fn(async () => ({ membershipSource: 'glofox', settings: {}, studioName: 'Stillorgan' })),
}))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn() }))

import { POST } from './route.js'
import { readPublicClasses } from '@/lib/public-classes'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { writeContactTag } from '@/lib/contact-tags'
import { createClassBookingPayment } from '@/lib/class-booking-payments'

const CFG = { type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+', trial_membership_id: 'elite-m', trial_plan_code: 'elite-p' }
const FIFTY = { event_id: 'ev-50', name: 'THE 50+ CLUB', starts_at: '2099-01-05T11:00:00.000Z' }
const book = (extra = {}) => POST(new Request('http://localhost/api/public/class-booking', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    path: 'stillorgan', campaign: '50plus', event_id: 'ev-50', first_name: 'Mary', last_name: 'Byrne',
    email: 'mary@example.com', phone: '0871234567', consent: true, ...extra,
  }),
}))

beforeEach(() => { vi.clearAllMocks(); pageBlocks = []; inserted = null })

describe('POST /api/public/class-booking — campaign (FIFTYPLUS.1)', () => {
  it('books on the campaign block: allow-list read, its trial pair and tag, price 0', async () => {
    pageBlocks = [
      { type: 'class_funnel', tag: 'stillorgan-start', trial_membership_id: 'gen-m', trial_plan_code: 'gen-p', price_cents: 2000 },
      CFG,
    ]
    readPublicClasses.mockResolvedValueOnce({ classes: [FIFTY], error: null })
    findOrCreateRaceContact.mockResolvedValueOnce('c1')
    const res = await book()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, data: { queued: true } })
    expect(readPublicClasses).toHaveBeenCalledWith(expect.anything(), 'L1', 14, { allowKeywords: ['50+'] })
    expect(inserted).toMatchObject({ trial_membership_id: 'elite-m', trial_plan_code: 'elite-p', status: 'queued', class_name: 'THE 50+ CLUB' })
    expect(writeContactTag).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag: 'stillorgan-50plus' }))
    expect(createClassBookingPayment).not.toHaveBeenCalled()
  })

  it('refuses an event outside the allow-list even though it is a real class', async () => {
    pageBlocks = [CFG]
    readPublicClasses.mockResolvedValueOnce({ classes: [FIFTY], error: null })
    const res = await book({ event_id: 'ev-sc' })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('class_unavailable')
    expect(findOrCreateRaceContact).not.toHaveBeenCalled()
  })

  it("refuses not_configured when the trial pair is missing, in the operator's words", async () => {
    pageBlocks = [{ ...CFG, trial_plan_code: '', not_configured_text: 'Ring us.' }]
    const res = await book()
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, code: 'not_configured', error: 'Ring us.' })
    expect(readPublicClasses).not.toHaveBeenCalled()
    expect(findOrCreateRaceContact).not.toHaveBeenCalled()
  })

  it('unknown campaign is not_configured, never the class_funnel fallback', async () => {
    pageBlocks = [{ type: 'class_funnel', trial_membership_id: 'gen-m', trial_plan_code: 'gen-p' }]
    const res = await book()
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.code).toBe('not_configured')
    expect(j.error).toBe('Booking is not open online right now. Message us and we will book you in.')
    expect(inserted).toBe(null)
  })

  it("timetable_unavailable uses the block's text", async () => {
    pageBlocks = [{ ...CFG, timetable_unavailable_text: 'Try again shortly.' }]
    readPublicClasses.mockResolvedValueOnce({ classes: [], error: 'glofox_unreachable' })
    const res = await book()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'timetable_unavailable', error: 'Try again shortly.' })
  })

  it('no campaign keeps the class_funnel path: its trial pair, tag and the plain read', async () => {
    pageBlocks = [{ type: 'class_funnel', tag: 'stillorgan-start', trial_membership_id: 'gen-m', trial_plan_code: 'gen-p' }, CFG]
    readPublicClasses.mockResolvedValueOnce({ classes: [{ event_id: 'ev-1', name: 'BASE', starts_at: '2099-01-01T08:00:00Z' }], error: null })
    findOrCreateRaceContact.mockResolvedValueOnce('c1')
    const res = await book({ campaign: undefined, event_id: 'ev-1' })
    expect(res.status).toBe(200)
    expect(readPublicClasses).toHaveBeenCalledWith(expect.anything(), 'L1', 14)
    expect(inserted).toMatchObject({ trial_membership_id: 'gen-m', trial_plan_code: 'gen-p' })
    expect(writeContactTag).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag: 'stillorgan-start' }))
  })
})
