// POST /api/webhooks/stripe — the EVENT-MOVE.5 move_gap path only: a paid
// price difference gets the gap receipt (the move is settled inside
// markRacePaymentStatus), never the entry confirmation; a refunded one is
// logged and leaves the move settled.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/stripe', () => ({ verifyStripeWebhook: vi.fn(), getStripe: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/race-payments', () => ({ resolveRacePaymentByProviderRef: vi.fn(), markRacePaymentStatus: vi.fn() }))
vi.mock('@/lib/race-confirmations', () => ({
  sendRaceConfirmations: vi.fn(async () => ({ sent: ['email'] })),
  sendGapPaidEmail: vi.fn(async () => ({ sent: ['email'], skipped: [], failed: [] })),
}))
vi.mock('@/lib/orders', () => ({ syncOrderFromRacePayment: vi.fn(async () => {}) }))
vi.mock('@/lib/stripe-refund-sync', () => ({ refundPatchFromCharge: vi.fn(() => null) }))
vi.mock('@/lib/class-booking-payments', () => ({ resolveClassBookingPaymentByRef: vi.fn(), markClassBookingPaymentStatus: vi.fn() }))
vi.mock('@/lib/donation-payments', () => ({
  DONATION_COLS: 'id, status',
  resolveDonationByRef: vi.fn(),
  markDonationPaymentStatus: vi.fn(),
  markDonationRefunded: vi.fn(),
  runPaidDonationSideEffects: vi.fn(),
}))
vi.mock('@/lib/charity-donations', () => ({ resolveCharitySettings: vi.fn(() => ({ match_multiplier: 2 })) }))
vi.mock('@/lib/qstash', () => ({ publishQueuePush: vi.fn(), CLASS_BOOKINGS_WORKER_PATH: '/x' }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

const { POST } = await import('./route.js')
const { verifyStripeWebhook, getStripe } = await import('@/lib/stripe')
const { createServerClient } = await import('@/lib/supabase')
const { resolveRacePaymentByProviderRef, markRacePaymentStatus } = await import('@/lib/race-payments')
const { sendRaceConfirmations, sendGapPaidEmail } = await import('@/lib/race-confirmations')
const { logWarn } = await import('@/lib/log')
const { resolveDonationByRef, markDonationPaymentStatus, markDonationRefunded, runPaidDonationSideEffects } = await import('@/lib/donation-payments')

const GAP = { id: 'gp1', kind: 'move_gap', registration_move_id: 'mv1', status: 'pending' }
const completedEvent = { type: 'checkout.session.completed', data: { object: { id: 'cs_1', amount_total: 1000, metadata: { domain: 'un1t_race_gap' } } } }
const req = () => new Request('http://localhost/api/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 's' }, body: '{}' })

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue({})
  verifyStripeWebhook.mockReturnValue(completedEvent)
  resolveRacePaymentByProviderRef.mockResolvedValue(GAP)
  markRacePaymentStatus.mockResolvedValue({ applied: { status: 'completed', kind: 'move_gap' }, state_changed: true })
})

describe('POST /api/webhooks/stripe — move_gap (EVENT-MOVE.5)', () => {
  it('a fresh completion marks the payment and sends the gap receipt, never the entry confirmation', async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(markRacePaymentStatus).toHaveBeenCalledWith(expect.objectContaining({ payment: GAP, revolutState: 'completed', revolutAmount: 1000 }))
    expect(sendGapPaidEmail).toHaveBeenCalledTimes(1)
    expect(sendGapPaidEmail).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'gp1' }))
    expect(sendRaceConfirmations).not.toHaveBeenCalled()
  })
  it('a retry on an already-completed gap payment sends nothing', async () => {
    markRacePaymentStatus.mockResolvedValue({ applied: null, state_changed: false })
    await POST(req())
    expect(sendGapPaidEmail).not.toHaveBeenCalled()
    expect(sendRaceConfirmations).not.toHaveBeenCalled()
  })
  it('an entry payment still gets the entry confirmation, not the gap receipt', async () => {
    resolveRacePaymentByProviderRef.mockResolvedValue({ id: 'p1', kind: 'entry' })
    markRacePaymentStatus.mockResolvedValue({ applied: { status: 'completed' }, state_changed: true })
    await POST(req())
    expect(sendRaceConfirmations).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'p1' }))
    expect(sendGapPaidEmail).not.toHaveBeenCalled()
  })
  it('a thrown receipt is logged and still answers 200', async () => {
    sendGapPaidEmail.mockRejectedValueOnce(new Error('boom'))
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(logWarn).toHaveBeenCalledWith('stripe-webhook', 'gap receipt failed', expect.objectContaining({ paymentId: 'gp1' }))
  })
  it('charge.refunded on a gap payment logs that the move stays settled, and writes nothing to the move', async () => {
    verifyStripeWebhook.mockReturnValue({ type: 'charge.refunded', account: 'acct_1', data: { object: { id: 'ch_1', payment_intent: 'pi_1' } } })
    getStripe.mockReturnValue({ checkout: { sessions: { list: vi.fn(async () => ({ data: [{ id: 'cs_1' }] })) } } })
    const from = vi.fn()
    createServerClient.mockReturnValue({ from })
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(logWarn).toHaveBeenCalledWith('stripe-webhook', expect.stringContaining('the move stays settled'), { paymentId: 'gp1', moveId: 'mv1' })
    expect(from).not.toHaveBeenCalledWith('registration_moves')
  })
})

describe('POST /api/webhooks/stripe — un1t_donation (CHARITY.7)', () => {
  const DON = { id: 'd1', status: 'awaiting_payment', race_event_id: 'ev1', connected_account_id: 'acct_1' }
  const PAID = { ...DON, status: 'paid' }
  const RACE = { id: 'ev1', charity: { match_multiplier: 2 } }
  const donationEvent = (type) => ({ type, data: { object: { id: 'cs_9', amount_total: 2500, metadata: { domain: 'un1t_donation' } } } })
  const refundEvent = { type: 'charge.refunded', account: 'acct_1', data: { object: { id: 'ch_1', payment_intent: 'pi_1' } } }
  const sessionsFor = (id) => ({ checkout: { sessions: { list: vi.fn(async () => ({ data: [{ id }] })) } } })
  let donationReads
  beforeEach(() => {
    donationReads = { data: PAID, error: null }
    const chain = (table) => {
      const c = { select: () => c, eq: () => c, maybeSingle: async () => (table === 'donations' ? donationReads : { data: RACE, error: null }) }
      return c
    }
    createServerClient.mockReturnValue({ from: vi.fn(chain) })
    resolveDonationByRef.mockResolvedValue(DON)
    markDonationPaymentStatus.mockResolvedValue({ status: 'paid', changed: true })
    markDonationRefunded.mockResolvedValue({ changed: true })
    runPaidDonationSideEffects.mockResolvedValue({})
  })

  it('checkout.session.completed marks the donation paid, re-reads, runs side effects, and never touches race_payments', async () => {
    verifyStripeWebhook.mockReturnValue(donationEvent('checkout.session.completed'))
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(resolveDonationByRef).toHaveBeenCalledWith(expect.anything(), 'cs_9')
    expect(markDonationPaymentStatus).toHaveBeenCalledWith(expect.objectContaining({ donation: DON, providerState: 'completed', providerAmount: 2500, multiplier: 2 }))
    expect(runPaidDonationSideEffects).toHaveBeenCalledWith(expect.objectContaining({ donation: PAID, race: RACE }))
    expect(resolveRacePaymentByProviderRef).not.toHaveBeenCalled()
  })
  it('a replayed completion on an already-paid row still runs the (stamp-keyed) side effects', async () => {
    verifyStripeWebhook.mockReturnValue(donationEvent('checkout.session.completed'))
    resolveDonationByRef.mockResolvedValue(PAID)
    markDonationPaymentStatus.mockResolvedValue({ status: 'paid', changed: false })
    await POST(req())
    expect(runPaidDonationSideEffects).toHaveBeenCalledTimes(1)
  })
  it('an unknown donation session answers 200 and does nothing', async () => {
    verifyStripeWebhook.mockReturnValue(donationEvent('checkout.session.completed'))
    resolveDonationByRef.mockResolvedValue(null)
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(markDonationPaymentStatus).not.toHaveBeenCalled()
    expect(runPaidDonationSideEffects).not.toHaveBeenCalled()
  })
  it('checkout.session.expired marks the donation expired', async () => {
    verifyStripeWebhook.mockReturnValue(donationEvent('checkout.session.expired'))
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(markDonationPaymentStatus).toHaveBeenCalledWith(expect.objectContaining({ donation: DON, providerState: 'expired' }))
    expect(runPaidDonationSideEffects).not.toHaveBeenCalled()
    expect(resolveRacePaymentByProviderRef).not.toHaveBeenCalled()
  })
  it('charge.refunded with no race_payments match but a donations match marks the donation refunded', async () => {
    verifyStripeWebhook.mockReturnValue(refundEvent)
    getStripe.mockReturnValue(sessionsFor('cs_9'))
    resolveRacePaymentByProviderRef.mockResolvedValue(null)
    resolveDonationByRef.mockResolvedValue(PAID)
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(resolveDonationByRef).toHaveBeenCalledWith(expect.anything(), 'cs_9')
    expect(markDonationRefunded).toHaveBeenCalledWith({ db: expect.anything(), donationId: 'd1', byProfileId: null })
  })
  it('charge.refunded with neither a race payment nor a donation does not refund anything', async () => {
    verifyStripeWebhook.mockReturnValue(refundEvent)
    getStripe.mockReturnValue(sessionsFor('cs_9'))
    resolveRacePaymentByProviderRef.mockResolvedValue(null)
    resolveDonationByRef.mockResolvedValue(null)
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(markDonationRefunded).not.toHaveBeenCalled()
  })
  it('charge.refunded on a race payment never looks at donations', async () => {
    verifyStripeWebhook.mockReturnValue(refundEvent)
    getStripe.mockReturnValue(sessionsFor('cs_1'))
    resolveRacePaymentByProviderRef.mockResolvedValue(GAP)
    await POST(req())
    expect(resolveDonationByRef).not.toHaveBeenCalled()
  })
})
