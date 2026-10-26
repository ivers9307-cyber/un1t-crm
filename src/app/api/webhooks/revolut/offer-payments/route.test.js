import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyWebhookSignature = vi.fn(() => true)
const getOrder = vi.fn(async () => ({ id: 'ord_1', state: 'completed', amount: 49700 }))
vi.mock('@/lib/revolut', () => ({
  verifyWebhookSignature: (...a) => verifyWebhookSignature(...a),
  getOrder: (...a) => getOrder(...a),
}))

const recordWebhookEvent = vi.fn(async () => ({ seen: false }))
const releaseWebhookEvent = vi.fn(async () => {})
vi.mock('@/lib/webhook-events', () => ({
  recordWebhookEvent: (...a) => recordWebhookEvent(...a),
  releaseWebhookEvent: (...a) => releaseWebhookEvent(...a),
  WEBHOOK_PROVIDERS: { REVOLUT_OFFER: 'revolut_offer' },
}))

const purchase = { id: 'p1', state: 'created', location_id: 'loc1', revolut_order_id: 'ord_1', offer: { name: '3 Month Membership' } }
const resolveOfferPurchaseByOrderId = vi.fn(async () => purchase)
const markOfferPurchaseState = vi.fn(async () => ({ changed: true, state: 'paid' }))
const linkOrCreateContactForPurchase = vi.fn(async () => ({ contactId: 'c1' }))
const notifyStaffOfPaidPurchase = vi.fn(async () => ({ sent: true }))
vi.mock('@/lib/sale-offers', () => ({
  resolveOfferPurchaseByOrderId: (...a) => resolveOfferPurchaseByOrderId(...a),
  markOfferPurchaseState: (...a) => markOfferPurchaseState(...a),
  linkOrCreateContactForPurchase: (...a) => linkOrCreateContactForPurchase(...a),
  notifyStaffOfPaidPurchase: (...a) => notifyStaffOfPaidPurchase(...a),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({}) }))

import { POST, GET } from './route'

function makeRequest(payload) {
  return new Request('http://test/api/webhooks/revolut/offer-payments', {
    method: 'POST',
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    headers: { 'revolut-signature': 'v1=abc', 'revolut-request-timestamp': '1' },
  })
}

beforeEach(() => {
  verifyWebhookSignature.mockClear(); verifyWebhookSignature.mockReturnValue(true)
  getOrder.mockClear(); getOrder.mockResolvedValue({ id: 'ord_1', state: 'completed', amount: 49700 })
  recordWebhookEvent.mockClear(); recordWebhookEvent.mockResolvedValue({ seen: false })
  releaseWebhookEvent.mockClear()
  resolveOfferPurchaseByOrderId.mockClear(); resolveOfferPurchaseByOrderId.mockResolvedValue(purchase)
  markOfferPurchaseState.mockClear(); markOfferPurchaseState.mockResolvedValue({ changed: true, state: 'paid' })
  linkOrCreateContactForPurchase.mockClear()
  notifyStaffOfPaidPurchase.mockClear()
})

describe('POST /api/webhooks/revolut/offer-payments', () => {
  it('401 on a bad signature', async () => {
    verifyWebhookSignature.mockReturnValue(false)
    expect((await POST(makeRequest({ event: 'ORDER_COMPLETED', order_id: 'ord_1' }))).status).toBe(401)
  })
  it('200 + dedupe short-circuit when the event was already seen', async () => {
    recordWebhookEvent.mockResolvedValueOnce({ seen: true })
    const json = await (await POST(makeRequest({ event: 'ORDER_COMPLETED', order_id: 'ord_1' }))).json()
    expect(json.deduped).toBe(true)
    expect(getOrder).not.toHaveBeenCalled()
  })
  it('200 + skipped for an unknown order id, with NO dedupe claim (REVPAY.1)', async () => {
    resolveOfferPurchaseByOrderId.mockResolvedValueOnce(null)
    const json = await (await POST(makeRequest({ event: 'ORDER_COMPLETED', order_id: 'ord_x' }))).json()
    expect(json.skipped).toBe('unknown_order')
    expect(recordWebhookEvent).not.toHaveBeenCalled()
  })
  it('resolves strictly; a failed lookup defers with nothing claimed', async () => {
    resolveOfferPurchaseByOrderId.mockRejectedValueOnce(new Error('db down'))
    const json = await (await POST(makeRequest({ event: 'ORDER_COMPLETED', order_id: 'ord_1' }))).json()
    expect(resolveOfferPurchaseByOrderId).toHaveBeenCalledWith(expect.anything(), 'ord_1', { throwOnError: true })
    expect(json.deferred).toBe(true)
    expect(recordWebhookEvent).not.toHaveBeenCalled()
    expect(releaseWebhookEvent).not.toHaveBeenCalled()
  })
  it('a thrown state write defers and RELEASES the claim, no side effects', async () => {
    markOfferPurchaseState.mockRejectedValueOnce(new Error('offer_purchases update: down'))
    const res = await POST(makeRequest({ event: 'ORDER_COMPLETED', order_id: 'ord_1' }))
    expect(res.status).toBe(200)
    expect((await res.json()).deferred).toBe(true)
    expect(releaseWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ provider: 'revolut_offer', eventId: 'ORDER_COMPLETED:ord_1' }))
    expect(linkOrCreateContactForPurchase).not.toHaveBeenCalled()
  })
  it('a landed state write never releases the claim, even when side effects throw', async () => {
    linkOrCreateContactForPurchase.mockRejectedValueOnce(new Error('boom'))
    await POST(makeRequest({ event: 'ORDER_COMPLETED', order_id: 'ord_1' }))
    expect(releaseWebhookEvent).not.toHaveBeenCalled()
  })
  it('ORDER_COMPLETED → fresh getOrder state marks paid and runs side effects', async () => {
    const json = await (await POST(makeRequest({ event: 'ORDER_COMPLETED', order_id: 'ord_1' }))).json()
    expect(getOrder).toHaveBeenCalledWith('ord_1')
    expect(markOfferPurchaseState).toHaveBeenCalledWith(expect.objectContaining({ purchase, providerState: 'completed' }))
    expect(linkOrCreateContactForPurchase).toHaveBeenCalled()
    expect(notifyStaffOfPaidPurchase).toHaveBeenCalled()
    expect(json.state).toBe('paid')
  })
  it('side-effect failure still returns 200', async () => {
    linkOrCreateContactForPurchase.mockRejectedValueOnce(new Error('boom'))
    expect((await POST(makeRequest({ event: 'ORDER_COMPLETED', order_id: 'ord_1' }))).status).toBe(200)
  })
  it('no change (already paid) → no side effects re-run', async () => {
    markOfferPurchaseState.mockResolvedValueOnce({ changed: false, state: 'paid' })
    await POST(makeRequest({ event: 'ORDER_COMPLETED', order_id: 'ord_1' }))
    expect(linkOrCreateContactForPurchase).not.toHaveBeenCalled()
    expect(notifyStaffOfPaidPurchase).not.toHaveBeenCalled()
  })
  it('failed payment marks failed without side effects', async () => {
    getOrder.mockResolvedValueOnce({ id: 'ord_1', state: 'failed' })
    markOfferPurchaseState.mockResolvedValueOnce({ changed: true, state: 'failed' })
    const json = await (await POST(makeRequest({ event: 'ORDER_PAYMENT_FAILED', order_id: 'ord_1' }))).json()
    expect(json.state).toBe('failed')
    expect(linkOrCreateContactForPurchase).not.toHaveBeenCalled()
  })
  it('empty body (verification ping) → 200', async () => {
    expect((await POST(makeRequest(''))).status).toBe(200)
  })
  it('getOrder failure defers (200, no state write)', async () => {
    getOrder.mockRejectedValueOnce(new Error('revolut down'))
    const json = await (await POST(makeRequest({ event: 'ORDER_COMPLETED', order_id: 'ord_1' }))).json()
    expect(json.deferred).toBe(true)
    expect(markOfferPurchaseState).not.toHaveBeenCalled()
    expect(releaseWebhookEvent).toHaveBeenCalledTimes(1)
  })
})

describe('GET', () => {
  it('200 for Revolut URL validation', async () => {
    expect((await GET()).status).toBe(200)
  })
})
