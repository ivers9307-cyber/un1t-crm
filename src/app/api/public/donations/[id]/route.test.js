// CHARITY.6 — GET /api/public/donations/[id]: unknown id is a 404, a pending
// row is re-checked against the provider (rate-capped, no provider call when
// capped), a paid observation re-reads the row before the side effects run and
// runs them on every observation (also when already paid, also when the event
// has since switched charity off), and no donor field is ever returned.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(), getPayment: vi.fn(), mark: vi.fn(), sideEffects: vi.fn(), donation: vi.fn(), event: vi.fn(), warn: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.rateLimit, getClientIp: () => '1.2.3.4' }))
vi.mock('@/lib/payments', () => ({ paymentsFor: () => ({ getPayment: mocks.getPayment }) }))
vi.mock('@/lib/donation-payments', () => ({
  DONATION_COLS: 'id, status',
  markDonationPaymentStatus: mocks.mark,
  runPaidDonationSideEffects: mocks.sideEffects,
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: mocks.warn }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      if (table === 'donations') return { select: () => ({ eq: () => ({ maybeSingle: mocks.donation }) }) }
      if (table === 'race_events') return { select: () => ({ eq: () => ({ maybeSingle: mocks.event }) }) }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import { GET } from './route'

const PENDING = {
  id: 'd1', race_event_id: 'ev1', status: 'awaiting_payment', amount_cents: 2500, currency: 'EUR', match_multiplier: 1,
  payment_provider: 'revolut', payment_provider_ref: 'ord1', payment_checkout_token: 'tok', payment_checkout_url: null, connected_account_id: null,
  donor_name: 'Ava Byrne', donor_email: 'ava@example.com', message: 'Go team', contact_id: null,
}
const PAID = { ...PENDING, status: 'paid', match_multiplier: 2 }
const EVENT = { id: 'ev1', name: 'Hyrox', slug: 'hyrox', location_id: 'loc1', charity_enabled: true, charity: { match_multiplier: 2 }, payment_currency: 'EUR' }
const call = () => GET(new Request('http://x/api/public/donations/d1'), { params: Promise.resolve({ id: 'd1' }) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.donation.mockReset()
  mocks.donation.mockResolvedValue({ data: PENDING, error: null })
  mocks.event.mockResolvedValue({ data: EVENT, error: null })
  mocks.getPayment.mockResolvedValue({ state: 'completed', amountCents: 2500 })
  mocks.mark.mockResolvedValue({ status: 'paid', changed: true })
  mocks.sideEffects.mockResolvedValue({ contact: 'linked', consent: 'skipped', receipt: 'sent' })
})

describe('GET /api/public/donations/[id]', () => {
  it('404s an unknown id', async () => {
    mocks.donation.mockResolvedValue({ data: null, error: null })
    const r = await call()
    expect(r.status).toBe(404)
    expect(mocks.getPayment).not.toHaveBeenCalled()
  })

  it('re-checks a pending row, marks it paid at the event multiplier, re-reads, and runs the side effects on the fresh row', async () => {
    mocks.donation.mockResolvedValueOnce({ data: PENDING, error: null }).mockResolvedValueOnce({ data: PAID, error: null })
    const r = await call()
    const body = await r.json()
    // The checkout polls every 3 s: 100 per 5 minutes covers the whole window.
    expect(mocks.rateLimit).toHaveBeenCalledWith(expect.anything(), 'dpoll:d1', { max: 100, windowMs: 5 * 60_000 })
    expect(mocks.getPayment).toHaveBeenCalledWith('ord1', { connectedAccountId: null })
    expect(mocks.mark).toHaveBeenCalledWith(expect.objectContaining({ donation: PENDING, providerState: 'completed', providerAmount: 2500, multiplier: 2 }))
    expect(mocks.sideEffects).toHaveBeenCalledTimes(1)
    expect(mocks.sideEffects).toHaveBeenCalledWith(expect.objectContaining({ donation: PAID, race: EVENT, ipAddress: '1.2.3.4', observerWon: true }))
    expect(body.data).toEqual({ id: 'd1', state: 'paid', paid: true, amount_cents: 2500, currency: 'EUR', match_multiplier: 2, checkout: null })
  })

  it('a re-check that lost the mark to the webhook passes observerWon false', async () => {
    mocks.donation.mockResolvedValueOnce({ data: PENDING, error: null }).mockResolvedValueOnce({ data: PAID, error: null })
    mocks.mark.mockResolvedValue({ status: 'paid', changed: false })
    await call()
    expect(mocks.sideEffects).toHaveBeenCalledWith(expect.objectContaining({ donation: PAID, observerWon: false }))
  })

  it('logs a failed re-read after the mark and answers from the row it already had', async () => {
    mocks.donation.mockResolvedValueOnce({ data: PENDING, error: null }).mockResolvedValueOnce({ data: null, error: { message: 'db down' } })
    const r = await call()
    expect(r.status).toBe(200)
    expect(mocks.warn).toHaveBeenCalledWith('donation-poll', 're-read after mark failed', expect.objectContaining({ donationId: 'd1' }))
    expect((await r.json()).data.state).toBe('pending')
    expect(mocks.sideEffects).not.toHaveBeenCalled()
  })

  it('answers paid false while pending', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false })
    const body = await (await call()).json()
    expect(body.data.paid).toBe(false)
  })

  it('runs the side effects on an already-paid row without asking the provider, and still when the event has switched charity off', async () => {
    mocks.donation.mockResolvedValue({ data: PAID, error: null })
    mocks.event.mockResolvedValue({ data: { ...EVENT, charity_enabled: false }, error: null })
    const r = await call()
    expect((await r.json()).data.state).toBe('paid')
    expect(mocks.getPayment).not.toHaveBeenCalled()
    expect(mocks.mark).not.toHaveBeenCalled()
    // No mark happened on this poll, so it is not the winning observer.
    expect(mocks.sideEffects).toHaveBeenCalledWith(expect.objectContaining({ donation: PAID, observerWon: false, race: expect.objectContaining({ charity_enabled: false }) }))
  })

  it('still marks paid when the event has switched charity off', async () => {
    mocks.event.mockResolvedValue({ data: { ...EVENT, charity_enabled: false }, error: null })
    mocks.donation.mockResolvedValueOnce({ data: PENDING, error: null }).mockResolvedValueOnce({ data: PAID, error: null })
    const r = await call()
    expect((await r.json()).data.state).toBe('paid')
    expect(mocks.mark).toHaveBeenCalledWith(expect.objectContaining({ multiplier: 2 }))
    expect(mocks.sideEffects).toHaveBeenCalledTimes(1)
  })

  it('does not call the provider when rate-capped and answers pending with the checkout', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false })
    const r = await call()
    const body = await r.json()
    expect(mocks.getPayment).not.toHaveBeenCalled()
    expect(mocks.mark).not.toHaveBeenCalled()
    expect(mocks.sideEffects).not.toHaveBeenCalled()
    expect(body.data.state).toBe('pending')
    expect(body.data.checkout).toEqual({ provider: 'revolut', token: 'tok', url: null, connectedAccountId: null })
  })

  it('answers the current state when the provider re-check throws, and never 500s', async () => {
    mocks.getPayment.mockRejectedValue(new Error('provider down'))
    const r = await call()
    expect(r.status).toBe(200)
    expect((await r.json()).data.state).toBe('pending')
    expect(mocks.warn).toHaveBeenCalledWith('donation-poll', expect.any(String), expect.anything())
    expect(mocks.sideEffects).not.toHaveBeenCalled()
  })

  it('does not re-check a failed row and returns no checkout', async () => {
    mocks.donation.mockResolvedValue({ data: { ...PENDING, status: 'failed' }, error: null })
    const r = await call()
    const body = await r.json()
    expect(mocks.rateLimit).not.toHaveBeenCalled()
    expect(mocks.getPayment).not.toHaveBeenCalled()
    expect(body.data.state).toBe('failed')
    expect(body.data.checkout).toBeNull()
  })

  it('a throwing side-effects step does not fail the poll', async () => {
    mocks.donation.mockResolvedValue({ data: PAID, error: null })
    mocks.sideEffects.mockRejectedValue(new Error('boom'))
    const r = await call()
    expect(r.status).toBe(200)
    expect((await r.json()).data.state).toBe('paid')
  })

  it('returns no donor fields of any kind', async () => {
    mocks.donation.mockResolvedValue({ data: PAID, error: null })
    const text = await (await call()).text()
    for (const k of ['donor_name', 'donor_email', 'message', 'contact_id', 'Ava', 'ava@example.com', 'Go team']) expect(text).not.toContain(k)
  })
})
