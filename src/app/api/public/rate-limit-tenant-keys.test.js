// SAAS-6 — tenant-keyed rate-limit buckets.
//
// rate_limit_buckets keys are caller-built text; pre-SAAS-6 the public
// routes keyed on IP alone, so ONE shared bucket served every tenant —
// tenant A's traffic could exhaust tenant B's window for the same IP.
// These tests pin the exact key string each swept route passes to
// checkRateLimit (via the module mock): a forgotten tenant prefix
// fails the pin. Kept-global sites (token-enumeration guards) are
// pinned too so they don't silently GROW a prefix built from
// caller-supplied input.
//
// checkRateLimit resolves { allowed: false } so every route returns
// 429 straight after composing its key — no downstream mocking needed
// beyond what runs BEFORE the limiter (body validation; the book
// route's event lookup).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: false, remaining: 0, resetAt: new Date(0), retryAfterSec: 60 })),
  getClientIp: vi.fn((request) => request.headers.get('x-forwarded-for') || 'unknown'),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ success: false, error: 'rate limited' }), { status: 429 })),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))

import { checkRateLimit } from '@/lib/rate-limit'
import { createServerClient } from '@/lib/supabase'

import { GET as availabilityGET } from './bookings/[slug]/availability/route.js'
import { POST as hostListPOST } from './host-list/[slug]/subscribe/route.js'
import { POST as eventRegisterPOST } from './events/[slug]/register/route.js'
import { POST as raceRegisterPOST } from './races/[slug]/register/route.js'
import { POST as checkMemberPOST } from './events/[slug]/check-member/route.js'
import { GET as classesGET } from './classes/route.js'
import { POST as classBookingPOST } from './class-booking/route.js'
import { POST as leadsPOST } from './leads/route.js'
import { POST as funnelEventPOST } from './funnel-event/route.js'
import { POST as bookPOST } from './book/route.js'
import { GET as preferencesGET } from '../preferences/[token]/route.js'
import { POST as unsubscribePOST } from '../unsubscribe/[token]/route.js'
import { GET as depositGET } from './deposit/[token]/route.js'
import { POST as depositPayPOST } from './deposit/[token]/accept-and-pay/route.js'

const IP = '203.0.113.9'
const LOC_A = 'aaaaaaaa-0000-0000-0000-0000000000aa'
const EVENT_TYPE = 'cccccccc-0000-0000-0000-0000000000cc'

function req(url, { method = 'GET', body } = {}) {
  return new Request(`http://test.local${url}`, {
    method,
    headers: {
      'x-forwarded-for': IP,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function props(params) {
  return { params: Promise.resolve(params) }
}

function limiterKey() {
  expect(checkRateLimit).toHaveBeenCalledTimes(1)
  return checkRateLimit.mock.calls[0][1]
}

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue({})
})

describe('SAAS-6 tenant-keyed rate limits — swept call sites', () => {
  it('bookings availability keys on the booking-page slug', async () => {
    const res = await availabilityGET(req('/api/public/bookings/pt-intro/availability'), props({ slug: 'pt-intro' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`pubavail:pt-intro:${IP}`)
  })

  it('host-list subscribe keys on the host slug', async () => {
    const res = await hostListPOST(req('/api/public/host-list/runclub/subscribe', { method: 'POST', body: {} }), props({ slug: 'runclub' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`host-list:runclub:${IP}`)
  })

  it('event register keys on the event slug', async () => {
    const res = await eventRegisterPOST(req('/api/public/events/city-race/register', { method: 'POST', body: {} }), props({ slug: 'city-race' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`race-register:city-race:${IP}`)
  })

  it('race register keys on the race slug', async () => {
    const res = await raceRegisterPOST(req('/api/public/races/hyrox/register', { method: 'POST', body: {} }), props({ slug: 'hyrox' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`race-register:hyrox:${IP}`)
  })

  it('event check-member keys on the event slug', async () => {
    const res = await checkMemberPOST(req('/api/public/events/city-race/check-member', { method: 'POST', body: {} }), props({ slug: 'city-race' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`race-check-member:city-race:${IP}`)
  })

  it('public classes keys on the resolved ?path= tenant (defaulting to stillorgan)', async () => {
    let res = await classesGET(req('/api/public/classes'))
    expect(res.status).toBe(429)
    expect(checkRateLimit.mock.calls[0][1]).toBe(`pubclasses:stillorgan:${IP}`)

    res = await classesGET(req('/api/public/classes?path=hatch-street'))
    expect(res.status).toBe(429)
    expect(checkRateLimit.mock.calls[1][1]).toBe(`pubclasses:hatch-street:${IP}`)
  })

  it('class-booking keys on the landing path from the validated body (defaulting to stillorgan)', async () => {
    const body = {
      event_id: 'evt_1', first_name: 'A', last_name: 'B',
      email: 'a@example.com', phone: '0871234567', consent: true,
    }
    let res = await classBookingPOST(req('/api/public/class-booking', { method: 'POST', body: { ...body, path: 'hatch-street' } }))
    expect(res.status).toBe(429)
    expect(checkRateLimit.mock.calls[0][1]).toBe(`classbook:hatch-street:${IP}`)

    res = await classBookingPOST(req('/api/public/class-booking', { method: 'POST', body }))
    expect(res.status).toBe(429)
    expect(checkRateLimit.mock.calls[1][1]).toBe(`classbook:stillorgan:${IP}`)
  })

  it('class-booking: a malformed body 400s WITHOUT consuming the limiter window', async () => {
    const res = await classBookingPOST(req('/api/public/class-booking', { method: 'POST', body: {} }))
    expect(res.status).toBe(400)
    expect(checkRateLimit).not.toHaveBeenCalled()
  })

  it('leads keys on the landing public_path from the validated body', async () => {
    const res = await leadsPOST(req('/api/public/leads', {
      method: 'POST',
      body: { first_name: 'A', email: 'a@example.com', phone: '0871234567', consent: true, public_path: 'hatch-street' },
    }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`lead:hatch-street:${IP}`)
  })

  it('funnel-event keys on location_path (defaulting to stillorgan)', async () => {
    let res = await funnelEventPOST(req('/api/public/funnel-event', { method: 'POST', body: { location_path: 'hatch-street' } }))
    expect(res.status).toBe(429)
    expect(checkRateLimit.mock.calls[0][1]).toBe(`funnelevt:hatch-street:${IP}`)

    res = await funnelEventPOST(req('/api/public/funnel-event', { method: 'POST', body: {} }))
    expect(res.status).toBe(429)
    expect(checkRateLimit.mock.calls[1][1]).toBe(`funnelevt:stillorgan:${IP}`)
  })

  it('book keys on the event type\'s location', async () => {
    createServerClient.mockReturnValue({
      from: (table) => {
        if (table !== 'event_types') throw new Error(`unexpected table ${table}`)
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { name: 'Intro', duration_minutes: 30, custom_fields: null, create_in_glofox: false, location_id: LOC_A },
                error: null,
              }),
            }),
          }),
        }
      },
    })
    const res = await bookPOST(req('/api/public/book', {
      method: 'POST',
      body: { event_type_id: EVENT_TYPE, booking_date: '2026-08-01', start_time: '10:00', customer_name: 'A', customer_email: 'a@example.com' },
    }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`book:${LOC_A}:${IP}`)
  })

  it('book: an unknown event type 404s WITHOUT consuming the limiter window', async () => {
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      }),
    })
    const res = await bookPOST(req('/api/public/book', {
      method: 'POST',
      body: { event_type_id: EVENT_TYPE, booking_date: '2026-08-01', start_time: '10:00', customer_name: 'A', customer_email: 'a@example.com' },
    }))
    expect(res.status).toBe(404)
    expect(checkRateLimit).not.toHaveBeenCalled()
  })
})

describe('H2 — car-deposit token endpoints are rate limited', () => {
  it('deposit view keys on IP alone (anti-enumeration — the enumerator varies the token)', async () => {
    const res = await depositGET(req('/api/public/deposit/some-token'), props({ token: 'some-token' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`deposit-view:${IP}`)
  })

  it('accept-and-pay keys on token + IP (strict payment-initiation guard)', async () => {
    const res = await depositPayPOST(
      req('/api/public/deposit/some-token/accept-and-pay', { method: 'POST', body: { terms_version: 1 } }),
      props({ token: 'some-token' }),
    )
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`deposit-pay:some-token:${IP}`)
  })

  it('accept-and-pay: a malformed body 400s WITHOUT consuming the limiter window', async () => {
    const res = await depositPayPOST(
      req('/api/public/deposit/some-token/accept-and-pay', { method: 'POST', body: {} }),
      props({ token: 'some-token' }),
    )
    expect(res.status).toBe(400)
    expect(checkRateLimit).not.toHaveBeenCalled()
  })
})

describe('SAAS-6 — deliberately tenant-UNSCOPED sites stay IP-keyed', () => {
  it('preferences token endpoint keys on IP alone (anti-enumeration)', async () => {
    const res = await preferencesGET(req('/api/preferences/some-token'), props({ token: 'some-token' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`preferences:${IP}`)
  })

  it('unsubscribe token endpoint keys on IP alone (anti-enumeration)', async () => {
    const res = await unsubscribePOST(req('/api/unsubscribe/some-token', { method: 'POST', body: {} }), props({ token: 'some-token' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`unsubscribe:${IP}`)
  })
})
