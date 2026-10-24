import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyWebhookSignature = vi.fn(() => true)
const getOrder = vi.fn(async () => ({ id: 'ord_1', state: 'completed', amount: 2500 }))
vi.mock('@/lib/revolut', () => ({
  verifyWebhookSignature: (...a) => verifyWebhookSignature(...a),
  getOrder: (...a) => getOrder(...a),
}))

const recordWebhookEvent = vi.fn(async () => ({ seen: false }))
vi.mock('@/lib/webhook-events', () => ({
  recordWebhookEvent: (...a) => recordWebhookEvent(...a),
  WEBHOOK_PROVIDERS: { REVOLUT_DONATION: 'revolut_donation' },
}))

const donation = { id: 'd1', status: 'awaiting_payment', race_event_id: 'ev1', amount_cents: 2500 }
const paidDonation = { ...donation, status: 'paid', match_multiplier: 2 }
const resolveDonationByRef = vi.fn(async () => donation)
const markDonationPaymentStatus = vi.fn(async () => ({ status: 'paid', changed: true }))
const runPaidDonationSideEffects = vi.fn(async () => ({}))
vi.mock('@/lib/donation-payments', () => ({
  DONATION_COLS: 'id, status',
  resolveDonationByRef: (...a) => resolveDonationByRef(...a),
  markDonationPaymentStatus: (...a) => markDonationPaymentStatus(...a),
  runPaidDonationSideEffects: (...a) => runPaidDonationSideEffects(...a),
}))

vi.mock('@/lib/charity-donations', () => ({
  resolveCharitySettings: (race) => ({ match_multiplier: race?.charity?.match_multiplier || 1 }),
}))

const logWarn = vi.fn()
vi.mock('@/lib/log', () => ({ logWarn: (...a) => logWarn(...a), logError: vi.fn() }))

const raceRow = { id: 'ev1', name: 'Race', charity: { match_multiplier: 2 } }
let eventResult
let rereadResult
const from = vi.fn((table) => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => (table === 'donations' ? rereadResult : eventResult),
  }
  return chain
})
const createServerClient = vi.fn(() => ({ from }))
vi.mock('@/lib/supabase', () => ({ createServerClient: (...a) => createServerClient(...a) }))

import { POST, GET } from './route'

function makeRequest(payload) {
  return new Request('http://test/api/webhooks/revolut/donations', {
    method: 'POST',
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    headers: { 'revolut-signature': 'v1=abc', 'revolut-request-timestamp': '1' },
  })
}
const completed = { event: 'ORDER_COMPLETED', order_id: 'ord_1' }

beforeEach(() => {
  vi.clearAllMocks()
  verifyWebhookSignature.mockReturnValue(true)
  getOrder.mockResolvedValue({ id: 'ord_1', state: 'completed', amount: 2500 })
  recordWebhookEvent.mockResolvedValue({ seen: false })
  resolveDonationByRef.mockResolvedValue(donation)
  markDonationPaymentStatus.mockResolvedValue({ status: 'paid', changed: true })
  eventResult = { data: raceRow, error: null }
  rereadResult = { data: paidDonation, error: null }
  delete process.env.REVOLUT_DONATION_WEBHOOK_SECRET
  process.env.REVOLUT_WEBHOOK_SECRET = 'shared'
})

describe('POST /api/webhooks/revolut/donations', () => {
  it('401 on a bad signature, before any DB call', async () => {
    verifyWebhookSignature.mockReturnValue(false)
    expect((await POST(makeRequest(completed))).status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(recordWebhookEvent).not.toHaveBeenCalled()
  })
  it('verifies against the dedicated secret first, then the shared one', async () => {
    process.env.REVOLUT_DONATION_WEBHOOK_SECRET = 'dedicated'
    await POST(makeRequest(completed))
    expect(verifyWebhookSignature).toHaveBeenCalledWith(expect.any(String), 'v1=abc', '1', { secrets: ['dedicated', 'shared'] })
  })
  it('empty body (verification ping) -> 200', async () => {
    expect((await POST(makeRequest(''))).status).toBe(200)
    expect(createServerClient).not.toHaveBeenCalled()
  })
  it('200 + dedupe short-circuit when the event was already seen', async () => {
    recordWebhookEvent.mockResolvedValueOnce({ seen: true })
    const res = await POST(makeRequest(completed))
    expect(res.status).toBe(200)
    expect((await res.json()).deduped).toBe(true)
    expect(recordWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ provider: 'revolut_donation', eventId: 'ORDER_COMPLETED:ord_1' }))
    expect(getOrder).not.toHaveBeenCalled()
  })
  it('200 + skipped for an unknown order id', async () => {
    resolveDonationByRef.mockResolvedValueOnce(null)
    const res = await POST(makeRequest(completed))
    expect(res.status).toBe(200)
    expect((await res.json()).skipped).toBe('unknown_order')
    expect(getOrder).not.toHaveBeenCalled()
  })
  it('getOrder failure defers (200, no state write)', async () => {
    getOrder.mockRejectedValueOnce(new Error('revolut down'))
    const json = await (await POST(makeRequest(completed))).json()
    expect(json.deferred).toBe(true)
    expect(markDonationPaymentStatus).not.toHaveBeenCalled()
  })
  it('ORDER_COMPLETED marks paid with the event multiplier, re-reads, then runs side effects on the re-read row', async () => {
    const json = await (await POST(makeRequest(completed))).json()
    expect(getOrder).toHaveBeenCalledWith('ord_1')
    expect(markDonationPaymentStatus).toHaveBeenCalledWith(expect.objectContaining({
      donation, providerState: 'completed', providerAmount: 2500, multiplier: 2,
    }))
    expect(runPaidDonationSideEffects).toHaveBeenCalledTimes(1)
    const arg = runPaidDonationSideEffects.mock.calls[0][0]
    expect(arg.donation).toBe(paidDonation)
    expect(arg.race).toBe(raceRow)
    expect(markDonationPaymentStatus.mock.invocationCallOrder[0]).toBeLessThan(runPaidDonationSideEffects.mock.invocationCallOrder[0])
    expect(json.state).toBe('paid')
  })
  it('a second delivery on an already-paid row (no change) still runs the side effects', async () => {
    resolveDonationByRef.mockResolvedValueOnce(paidDonation)
    markDonationPaymentStatus.mockResolvedValueOnce({ status: 'paid', changed: false })
    const json = await (await POST(makeRequest({ event: 'ORDER_PAYMENT_AUTHORISED', order_id: 'ord_1' }))).json()
    expect(runPaidDonationSideEffects).toHaveBeenCalledTimes(1)
    expect(json.state).toBe('paid')
  })
  it('a failed payment marks failed without side effects', async () => {
    getOrder.mockResolvedValueOnce({ id: 'ord_1', state: 'failed' })
    markDonationPaymentStatus.mockResolvedValueOnce({ status: 'failed', changed: true })
    rereadResult = { data: { ...donation, status: 'failed' }, error: null }
    const json = await (await POST(makeRequest({ event: 'ORDER_PAYMENT_FAILED', order_id: 'ord_1' }))).json()
    expect(json.state).toBe('failed')
    expect(runPaidDonationSideEffects).not.toHaveBeenCalled()
  })
  it('an unreadable event row skips mark and side effects, warns, and answers 200', async () => {
    eventResult = { data: null, error: { message: 'db down' } }
    const res = await POST(makeRequest(completed))
    expect(res.status).toBe(200)
    expect(markDonationPaymentStatus).not.toHaveBeenCalled()
    expect(runPaidDonationSideEffects).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalled()
  })
  it('a re-read that fails skips the side effects and still answers 200', async () => {
    rereadResult = { data: null, error: { message: 'db down' } }
    const res = await POST(makeRequest(completed))
    expect(res.status).toBe(200)
    expect(runPaidDonationSideEffects).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalled()
  })
  it('a side-effect failure still answers 200', async () => {
    runPaidDonationSideEffects.mockRejectedValueOnce(new Error('boom'))
    expect((await POST(makeRequest(completed))).status).toBe(200)
  })
  it('an unrecognised payload (no event or order) answers 200', async () => {
    expect((await POST(makeRequest({ hello: 'world' }))).status).toBe(200)
    expect(resolveDonationByRef).not.toHaveBeenCalled()
  })
})

describe('GET', () => {
  it('200 for Revolut URL validation', async () => {
    expect((await GET()).status).toBe(200)
  })
})
