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
vi.mock('@/lib/qstash', () => ({ publishQueuePush: vi.fn(), CLASS_BOOKINGS_WORKER_PATH: '/x' }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

const { POST } = await import('./route.js')
const { verifyStripeWebhook, getStripe } = await import('@/lib/stripe')
const { createServerClient } = await import('@/lib/supabase')
const { resolveRacePaymentByProviderRef, markRacePaymentStatus } = await import('@/lib/race-payments')
const { sendRaceConfirmations, sendGapPaidEmail } = await import('@/lib/race-confirmations')
const { logWarn } = await import('@/lib/log')

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
