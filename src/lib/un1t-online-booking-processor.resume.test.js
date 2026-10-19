// UN1TWRITE.22 — the funnel over the REAL account step and write primitives
// (a fake un1t.online and a fake database): a crash after each send resumes
// from the ledger without a second create, trial or booking. Only the emails,
// the card and A's eligibility read are stubbed.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./error-events', () => ({ recordErrorEvent: vi.fn(async () => {}) }))
vi.mock('./tenant-host.js', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://hatch.example.test') }))

import { processUn1tClassBookingRequest } from './un1t-online-booking-processor'
import { createUn1tWriter, _resetUn1tWriteStateForTests } from './un1t-online-write.js'
import { grantTrial } from './un1t-online-write-ops.js'
import { LOC, ORG, STUDIO, EVENT, PRODUCT, NEW_USER, CONTACT, ok, created, page, makeFetch, makeDb, selfRes } from './un1t-online-write.test-helpers.js'

const HOUR = 3_600_000
const EMAIL = 'person.test@example.test'
const BOOKING_ID = '99999999-9999-4999-8999-999999999999'
const booking = () => ({ id: BOOKING_ID, event_id: EVENT, user_id: NEW_USER, studio_id: STUDIO, status: 'booked', created_at: new Date().toISOString(), updated_at: new Date().toISOString() })

let credits
function setup() {
  credits = { balance: 0, is_unlimited: false }
  const made = makeDb({
    settings: { un1t_online: { writes_enabled: true, funnel_enabled: true, trial_product_id: PRODUCT } },
    tables: {
      un1t_events: [{ id: 'e-row', location_id: LOC, un1t_id: EVENT, title: 'RALLY', status: 'scheduled', starts_at: new Date(Date.now() + 24 * HOUR).toISOString() }],
      contacts: [{ id: CONTACT, organization_id: ORG, first_name: 'Test', last_name: 'Person', name: 'Test Person', email: EMAIL, phone: null, un1t_user_id: null, ctwa_clid: null }],
      un1t_subscriptions: [],
      class_booking_requests: [{ id: 'q-1', location_id: LOC, contact_id: CONTACT, status: 'processing' }],
    },
  })
  let clientsAfterCreate = false
  const fetchImpl = makeFetch({
    'GET /api-token': [selfRes()],
    'GET /users/clients': [(req) => page(clientsAfterCreate ? [{ id: NEW_USER, email: EMAIL }] : [])(req)],
    'POST /users/clients': [(req) => { clientsAfterCreate = true; return created({ id: NEW_USER, email: EMAIL, reset_password_token: 'secret' })(req) }],
    [`GET /credits/ledgers/${NEW_USER}/${STUDIO}`]: [(req) => ok({ ...credits })(req)],
    [`GET /products/${PRODUCT}`]: [ok({ id: PRODUCT, title: 'Trial', type: 'one_time', status: 'active', price_amount: 0, price_currency: 'EUR' })],
    'POST /purchases/charge': [(req) => { credits = { balance: 3, is_unlimited: false }; return ok({ transactionId: 'tx-1' })(req) }],
    'POST /bookings': [created(booking())],
    [`GET /users/${NEW_USER}/bookings`]: [(req) => page([booking()])(req)],
    [`GET /bookings/${BOOKING_ID}`]: [ok(booking())],
    'POST /auth/forgot-password': [ok({ message: 'sent' }, {})],
  })
  const writerFactory = vi.fn((d, loc) => createUn1tWriter(d, loc, { fetchImpl, sleep: async () => {} }))
  const deps = {
    writerFactory,
    grantTrial: (db, args, d) => grantTrial(db, args, { ...d, trialEligibility: async () => ({ success: true, data: { eligible: true, reasons: [] } }) }),
    sendUn1tAccountEmail: vi.fn(async () => ({ sent: true, channel: 'email' })),
    sendManualBookingConfirmEmail: vi.fn(async () => ({ sent: true, channel: 'email' })),
    routeToReview: vi.fn(async (db, req, reason) => ({ outcome: 'needs_review', detail: reason })),
    sendCtwaConversion: vi.fn(async () => {}),
    sendWebsiteConversion: vi.fn(async () => {}),
  }
  return { ...made, fetchImpl, deps }
}
const request = () => ({
  id: 'q-1', location_id: LOC, contact_id: CONTACT, glofox_event_id: `un1t:${EVENT}`, class_name: 'RALLY',
  starts_at: new Date(Date.now() + 24 * HOUR).toISOString(),
  terms_accepted_at: '2026-10-18T09:00:00.000Z', terms_source: 'website', terms_version: 'v',
})
const ctx = { settings: { writesEnabled: true, funnelEnabled: true, sendsWelcome: false, welcomeSetsLogin: false, sendsBookingConfirmation: false }, studioName: 'Hatch Street', organizationId: ORG }
const writes = (f) => ['POST /users/clients', 'POST /purchases/charge', 'POST /bookings', 'POST /auth/forgot-password'].map((k) => f.count(k))

beforeEach(() => {
  vi.clearAllMocks()
  _resetUn1tWriteStateForTests()
  // Never the live API: a writer that is not the fake's fails loudly.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test: real network call') }))
})

describe('the funnel over the real primitives', () => {
  it('a new person: one create, one charge, one booking, one reset; the secrets never reach the database', async () => {
    const s = setup()
    const out = await processUn1tClassBookingRequest(s.db, request(), ctx, s.deps)
    expect(out).toEqual({ outcome: 'booked', detail: `un1t:${BOOKING_ID}` })
    expect(writes(s.fetchImpl)).toEqual([1, 1, 1, 1])
    expect(JSON.stringify(s.store)).not.toContain('secret')
    expect(s.store.class_booking_requests[0]).toMatchObject({ status: 'booked', glofox_booking_id: `un1t:${BOOKING_ID}` })
  })

  it('a crash after each send (rows left sent, past the in-flight window) resumes without a second create, trial or booking', async () => {
    const s = setup()
    await processUn1tClassBookingRequest(s.db, request(), ctx, s.deps)
    // As if the process died after every send, before recording the answer.
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    for (const r of s.store.un1t_write_events) {
      if (r.op !== 'forgot_password') Object.assign(r, { stage: 'sent', created_at: old, finished_at: null })
    }
    s.store.class_booking_requests[0].status = 'processing'
    _resetUn1tWriteStateForTests()
    const again = await processUn1tClassBookingRequest(s.db, request(), ctx, s.deps)
    expect(again.outcome).toBe('booked')
    expect(writes(s.fetchImpl)).toEqual([1, 1, 1, 1])
  })

  it('RF2: two requests for one person at once create exactly one account; the second retries', async () => {
    const s = setup()
    s.store.class_booking_requests.push({ id: 'q-2', location_id: LOC, contact_id: CONTACT, status: 'processing' })
    const results = await Promise.allSettled([
      processUn1tClassBookingRequest(s.db, request(), ctx, s.deps),
      processUn1tClassBookingRequest(s.db, { ...request(), id: 'q-2' }, ctx, s.deps),
    ])
    expect(s.fetchImpl.count('POST /users/clients')).toBe(1)
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason.name).toBe('Un1tFunnelRetry')
    expect(rejected[0].reason.code).toBe('UN1T_ATTEMPT_IN_FLIGHT')
    // The retry finds the account linked and books with no second create.
    _resetUn1tWriteStateForTests()
    const retried = await processUn1tClassBookingRequest(s.db, { ...request(), id: 'q-2' }, ctx, s.deps)
    expect(retried.outcome).toBe('booked')
    expect(s.fetchImpl.count('POST /users/clients')).toBe(1)
  })

  it('a plain re-run after success sends nothing new', async () => {
    const s = setup()
    await processUn1tClassBookingRequest(s.db, request(), ctx, s.deps)
    await processUn1tClassBookingRequest(s.db, request(), ctx, s.deps)
    expect(writes(s.fetchImpl)).toEqual([1, 1, 1, 1])
  })
})
