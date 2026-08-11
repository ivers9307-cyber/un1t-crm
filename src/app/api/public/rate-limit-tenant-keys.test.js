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
  // UNSUB-RL.1 — the consent token endpoints PEEK a per-IP invalid-token
  // budget before resolving the token, and only spend it when the token turns
  // out not to resolve. Blocking here is what makes them return 429.
  peekRateLimit: vi.fn(async () => ({ allowed: false, remaining: 0, resetAt: new Date(0), retryAfterSec: 60 })),
  getClientIp: vi.fn((request) => request.headers.get('x-forwarded-for') || 'unknown'),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ success: false, error: 'rate limited' }), { status: 429 })),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))

import { checkRateLimit, peekRateLimit } from '@/lib/rate-limit'
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
import { GET as bcaFileGET } from './bca/[token]/file/[slug]/route.js'
import { GET as bcaMergedGET } from './bca/[token]/merged/route.js'
import { GET as bookingTypeGET } from './bookings/[slug]/route.js'
import { GET as slotsGET } from './bookings/[slug]/slots/route.js'
import { GET as brandingGET } from './branding/route.js'
import { GET as challengesGET } from './challenges/[locationId]/route.js'
import { GET as eventPaymentGET } from './event-payments/[id]/route.js'
import { GET as eventRegistrationGET } from './event-registrations/[id]/route.js'
import { GET as raceGET } from './events/[slug]/route.js'
import { GET as raceDisplayGET } from './events/[slug]/display/route.js'
import { GET as checkinQrGET } from './events/checkin-qr/route.js'
import { GET as hostConnectGET } from './host-connect/[token]/route.js'
import { POST as hostConnectStartPOST } from './host-connect/[token]/start/route.js'
import { GET as hostConnectRefreshGET } from './host-connect/[token]/refresh/route.js'
import { GET as presentStateGET } from './presentations/[token]/state/route.js'
import { GET as tvContentGET } from './tv/[token]/content/route.js'
import { signCheckinToken } from '@/lib/event-checkin-tokens'
import { signHostOnboardingToken } from '@/lib/host-onboarding-tokens'

const IP = '203.0.113.9'
const LOC_A = 'aaaaaaaa-0000-0000-0000-0000000000aa'
const EVENT_TYPE = 'cccccccc-0000-0000-0000-0000000000cc'
const REG_ID = 'dddddddd-0000-0000-0000-0000000000dd'
const PAY_ID = 'eeeeeeee-0000-0000-0000-0000000000ee'
const HOST_ID = 'ffffffff-0000-0000-0000-0000000000ff'

// The H2a routes verify HMAC tokens (checkin-qr, host-connect) before their
// limiter, and host-connect/refresh calls getAppUrl() up front — both read
// env at request time. Vitest runs each test file in its own process, so
// setting these here can't leak into other files.
const SIGNING_SECRET = 'test-signing-secret'
process.env.SUPABASE_SERVICE_ROLE_KEY = SIGNING_SECRET
process.env.NEXT_PUBLIC_APP_URL = 'http://test.local'

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

describe('H2a — remaining public routes are rate limited', () => {
  it('bca file download keys on IP alone (anti-enumeration)', async () => {
    const res = await bcaFileGET(req('/api/public/bca/tok/file/doc_01'), props({ token: 'tok', slug: 'doc_01' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`bca-file:${IP}`)
  })

  it('bca file: an invalid slug 400s WITHOUT consuming the limiter window', async () => {
    const res = await bcaFileGET(req('/api/public/bca/tok/file/evil'), props({ token: 'tok', slug: 'evil' }))
    expect(res.status).toBe(400)
    expect(checkRateLimit).not.toHaveBeenCalled()
  })

  it('bca merged download keys on IP alone (anti-enumeration)', async () => {
    const res = await bcaMergedGET(req('/api/public/bca/tok/merged'), props({ token: 'tok' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`bca-merged:${IP}`)
  })

  it('booking-type details keys on the booking-page slug', async () => {
    const res = await bookingTypeGET(req('/api/public/bookings/pt-intro'), props({ slug: 'pt-intro' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`pubbooktype:pt-intro:${IP}`)
  })

  it('booking slots keys on the booking-page slug', async () => {
    const res = await slotsGET(req('/api/public/bookings/pt-intro/slots?date=2026-08-01'), props({ slug: 'pt-intro' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`pubslots:pt-intro:${IP}`)
  })

  it('booking slots: a malformed date 400s WITHOUT consuming the limiter window', async () => {
    const res = await slotsGET(req('/api/public/bookings/pt-intro/slots?date=nope'), props({ slug: 'pt-intro' }))
    expect(res.status).toBe(400)
    expect(checkRateLimit).not.toHaveBeenCalled()
  })

  it('branding keys on the requested location (defaulting to "default")', async () => {
    let res = await brandingGET(req('/api/public/branding'))
    expect(res.status).toBe(429)
    expect(checkRateLimit.mock.calls[0][1]).toBe(`pubbranding:default:${IP}`)

    res = await brandingGET(req(`/api/public/branding?location_id=${LOC_A}`))
    expect(res.status).toBe(429)
    expect(checkRateLimit.mock.calls[1][1]).toBe(`pubbranding:${LOC_A}:${IP}`)
  })

  it('challenges TV board keys on the location', async () => {
    const res = await challengesGET(req(`/api/public/challenges/${LOC_A}`), props({ locationId: LOC_A }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`pubchallenges:${LOC_A}:${IP}`)
  })

  it('event-payment status keys on IP alone (anti-enumeration — the enumerator varies the UUID)', async () => {
    const res = await eventPaymentGET(req(`/api/public/event-payments/${PAY_ID}`), props({ id: PAY_ID }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`event-payment:${IP}`)
  })

  it('event-registration summary keys on IP alone (anti-enumeration)', async () => {
    const res = await eventRegistrationGET(req(`/api/public/event-registrations/${REG_ID}`), props({ id: REG_ID }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`event-reg:${IP}`)
  })

  it('race details keys on the race slug', async () => {
    const res = await raceGET(req('/api/public/events/city-race'), props({ slug: 'city-race' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`pubrace:city-race:${IP}`)
  })

  it('race display board keys on the race slug (polled tier)', async () => {
    const res = await raceDisplayGET(req('/api/public/events/city-race/display'), props({ slug: 'city-race' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`race-display:city-race:${IP}`)
    // Polled every 2s by the race-day TV — pin the polled-tier size so a
    // future "tidy-up" to the 30/5min token-GET shape (which a legit board
    // WOULD hit) fails this test.
    expect(checkRateLimit.mock.calls[0][2]).toEqual({ max: 240, windowMs: 60_000 })
  })

  it('checkin-qr keys on IP alone, after the HMAC verify', async () => {
    const token = signCheckinToken(
      { eventId: EVENT_TYPE, registrationId: REG_ID, memberId: LOC_A },
      SIGNING_SECRET,
    )
    const res = await checkinQrGET(req(`/api/public/events/checkin-qr?t=${encodeURIComponent(token)}`))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`checkin-qr:${IP}`)
  })

  it('checkin-qr: an unsigned token 400s WITHOUT consuming the limiter window', async () => {
    const res = await checkinQrGET(req('/api/public/events/checkin-qr?t=garbage'))
    expect(res.status).toBe(400)
    expect(checkRateLimit).not.toHaveBeenCalled()
  })

  it('host-connect status keys on IP alone, after the HMAC verify', async () => {
    const token = signHostOnboardingToken({ hostId: HOST_ID }, SIGNING_SECRET)
    const res = await hostConnectGET(req(`/api/public/host-connect/${token}`), props({ token }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`host-connect-view:${IP}`)
  })

  it('host-connect: an unsigned token 400s WITHOUT consuming the limiter window', async () => {
    const res = await hostConnectGET(req('/api/public/host-connect/garbage'), props({ token: 'garbage' }))
    expect(res.status).toBe(400)
    expect(checkRateLimit).not.toHaveBeenCalled()
  })

  it('host-connect start keys on token + IP (strict Stripe-mutation guard)', async () => {
    const token = signHostOnboardingToken({ hostId: HOST_ID }, SIGNING_SECRET)
    const res = await hostConnectStartPOST(
      req(`/api/public/host-connect/${token}/start`, { method: 'POST' }),
      props({ token }),
    )
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`host-connect-start:${token}:${IP}`)
    expect(checkRateLimit.mock.calls[0][2]).toEqual({ max: 10, windowMs: 15 * 60_000 })
  })

  it('host-connect refresh keys on token + IP (mints a Stripe Account Link per hit)', async () => {
    const token = signHostOnboardingToken({ hostId: HOST_ID }, SIGNING_SECRET)
    const res = await hostConnectRefreshGET(req(`/api/public/host-connect/${token}/refresh`), props({ token }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`host-connect-refresh:${token}:${IP}`)
    expect(checkRateLimit.mock.calls[0][2]).toEqual({ max: 10, windowMs: 15 * 60_000 })
  })

  it('host-connect refresh: an unsigned token redirects WITHOUT consuming the limiter window', async () => {
    const res = await hostConnectRefreshGET(req('/api/public/host-connect/garbage/refresh'), props({ token: 'garbage' }))
    expect(res.status).toBe(307)
    expect(checkRateLimit).not.toHaveBeenCalled()
  })

  it('presentation state keys on token + IP (polled tier)', async () => {
    const res = await presentStateGET(req('/api/public/presentations/deck-tok/state'), props({ token: 'deck-tok' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`present-state:deck-tok:${IP}`)
    // Polled every 4s by PresentViewer — pin the polled-tier size.
    expect(checkRateLimit.mock.calls[0][2]).toEqual({ max: 240, windowMs: 60_000 })
  })

  it('tv content keys on token + IP (polled tier)', async () => {
    const res = await tvContentGET(req('/api/public/tv/tv-tok/content'), props({ token: 'tv-tok' }))
    expect(res.status).toBe(429)
    expect(limiterKey()).toBe(`tv-content:tv-tok:${IP}`)
    // Polled every ~3s by the /tv page — pin the polled-tier size.
    expect(checkRateLimit.mock.calls[0][2]).toEqual({ max: 240, windowMs: 60_000 })
  })
})

// UNSUB-RL.1 — the consent token endpoints used to sit in the block above,
// pinned to a flat `preferences:<ip>` / `unsubscribe:<ip>` key. That key was
// the defect: an RFC 8058 one-click POST comes from the recipient's MAIL
// PROVIDER (Gmail uses a shared proxy pool), so budgeting valid opt-outs per
// IP throttles unrelated people's withdrawals of consent and drops them
// silently. They keep an IP-keyed bucket — but it is now spent ONLY by callers
// whose token did not resolve, which is the population it was ever meant for.
describe('UNSUB-RL.1 — consent token endpoints budget invalid tokens per IP', () => {
  const UUID_TOKEN = '9f1c7c0e-0000-4000-8000-000000000001'

  it('preferences peeks a per-IP INVALID-token bucket', async () => {
    const res = await preferencesGET(req(`/api/preferences/${UUID_TOKEN}`), props({ token: UUID_TOKEN }))
    expect(res.status).toBe(429)
    expect(peekRateLimit.mock.calls[0][1]).toBe(`preferences:invalid:${IP}`)
  })

  it('unsubscribe peeks a per-IP INVALID-token bucket', async () => {
    const res = await unsubscribePOST(req(`/api/unsubscribe/${UUID_TOKEN}`, { method: 'POST', body: {} }), props({ token: UUID_TOKEN }))
    expect(res.status).toBe(429)
    expect(peekRateLimit.mock.calls[0][1]).toBe(`unsubscribe:invalid:${IP}`)
  })

  it('neither ever keys a VALID-token bucket on the caller IP', async () => {
    await unsubscribePOST(req(`/api/unsubscribe/${UUID_TOKEN}`, { method: 'POST', body: {} }), props({ token: UUID_TOKEN }))
    for (const [, key] of checkRateLimit.mock.calls) {
      if (key.includes(':token:')) expect(key).not.toContain(IP)
    }
  })
})
