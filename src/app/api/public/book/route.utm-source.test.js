// UTMSOURCE.1 — POST /api/public/book (the /start consult booking) stamps the
// contact's first-touch utm_source / utm_medium (mig 837). The /start funnel
// has sent both since TRIALLEAK.1, but this route's schema stripped them, so
// they reached nothing. The stamp's own rule (first touch, cleaned, never
// throws) is tested beside src/lib/contact-first-touch-source.js; here: the
// schema lets them through, the stamp is called for the booking's contact
// BEFORE the ad stamp, and the ad stamp is unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ order: [], stamp: vi.fn(), updates: [] }))

vi.mock('@/lib/contact-first-touch-source', () => ({ stampFirstTouchSource: m.stamp }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from(table) {
      let kind = 'select'
      let payload = null
      const settle = async () => {
        if (kind === 'insert') return { data: { id: 'bk-1', contact_id: 'c-1', location_id: 'L1', customer_email: 'sam@example.com', booking_date: '2026-10-21', start_time: '10:00:00' }, error: null }
        if (kind === 'update') { m.updates.push({ table, payload }); if ('attributed_at' in payload) m.order.push('ad'); return { error: null } }
        if (table === 'event_types') return { data: { id: 'et-1', name: 'Consultation', custom_fields: [], create_in_glofox: false, location_id: 'L1' }, error: null }
        return { data: null, error: null }
      }
      const b = {
        select: () => b,
        insert: (p) => { kind = 'insert'; payload = p; return b },
        update: (p) => { kind = 'update'; payload = p; return b },
        single: settle, maybeSingle: settle,
        then: (ok, no) => settle().then(ok, no),
      }
      for (const op of ['eq', 'is', 'in', 'order', 'limit']) b[op] = () => b
      return b
    },
  }),
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })), getClientIp: () => '1.2.3.4', rateLimitResponse: vi.fn() }))
vi.mock('@/lib/booking-slots', () => ({ findBookableSlot: vi.fn(async () => ({ slot: { start: '10:00:00', end: '10:30:00' } })) }))
vi.mock('@/lib/sequences', () => ({ triggerSequencesForBooking: vi.fn(), triggerSequencesForFirstBooking: vi.fn() }))
vi.mock('@/lib/booking-confirmations', () => ({ sendBookingConfirmation: vi.fn(async () => ({ sent: [] })), fmtBookingTime: () => 'Wed 10:00' }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: vi.fn() }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: vi.fn() }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: vi.fn() }))
vi.mock('@/lib/automations/booking-whatsapp-confirm', () => ({ maybeSendBookingWhatsappConfirm: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'

const post = (attribution) => POST(new Request('http://localhost/api/public/book', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    event_type_id: 'e0000000-0000-0000-0000-000000000001', booking_date: '2026-10-21', start_time: '10:00',
    customer_name: 'Sam', customer_email: 'sam@example.com', source: 'meta_book',
    ...(attribution ? { attribution } : {}),
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  m.order = []
  m.updates = []
  m.stamp.mockImplementation(async () => { m.order.push('source'); return { stamped: true } })
})

describe('POST /api/public/book — first-touch utm_source / utm_medium (UTMSOURCE.1)', () => {
  it('the schema keeps both, and the stamp runs for the booking contact before the ad stamp', async () => {
    const res = await post({ utm_campaign: 'c1', ad_provider: 'meta', ad_external_id: 'ad9', utm_source: 'facebook', utm_medium: 'paid' })
    expect(res.status).toBe(200)
    expect(m.stamp).toHaveBeenCalledTimes(1)
    expect(m.stamp).toHaveBeenCalledWith(expect.anything(), 'c-1', expect.objectContaining({ utm_source: 'facebook', utm_medium: 'paid' }), { module: 'book' })
    expect(m.order).toEqual(['source', 'ad'])
  })

  it('the ad stamp is unchanged: it never carries source or medium', async () => {
    await post({ utm_campaign: 'c1', ad_provider: 'meta', ad_external_id: 'ad9', utm_source: 'facebook', utm_medium: 'paid' })
    const ad = m.updates.find((u) => u.table === 'contacts' && 'attributed_at' in u.payload)
    expect(ad.payload).toMatchObject({ utm_campaign: 'c1', ad_external_id: 'ad9', ad_provider: 'meta' })
    expect('utm_source' in ad.payload || 'utm_medium' in ad.payload).toBe(false)
  })

  it('an organic visitor: the stamp is offered the values and no ad stamp is written', async () => {
    const res = await post({ utm_source: 'instagram', utm_medium: 'bio' })
    expect(res.status).toBe(200)
    expect(m.stamp).toHaveBeenCalledWith(expect.anything(), 'c-1', { utm_source: 'instagram', utm_medium: 'bio' }, { module: 'book' })
    expect(m.updates.some((u) => 'attributed_at' in u.payload || 'ad_provider' in u.payload)).toBe(false)
  })

  it('a value over 200 characters is refused by the schema (400), as its siblings are', async () => {
    const res = await post({ utm_source: 'a'.repeat(201) })
    expect(res.status).toBe(400)
    expect(m.stamp).not.toHaveBeenCalled()
  })
})
