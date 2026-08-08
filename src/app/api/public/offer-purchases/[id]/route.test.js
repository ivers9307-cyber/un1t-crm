import { describe, it, expect, vi, beforeEach } from 'vitest'

const getOrder = vi.fn(async () => ({ id: 'ord_1', state: 'completed' }))
vi.mock('@/lib/revolut', () => ({ getOrder: (...a) => getOrder(...a) }))
const checkRateLimit = vi.fn(async () => ({ allowed: true }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: (...a) => checkRateLimit(...a) }))
const markOfferPurchaseState = vi.fn(async () => ({ changed: true, state: 'paid' }))
const linkOrCreateContactForPurchase = vi.fn(async () => ({ contactId: 'c1' }))
const notifyStaffOfPaidPurchase = vi.fn(async () => ({ sent: true }))
vi.mock('@/lib/sale-offers', () => ({
  markOfferPurchaseState: (...a) => markOfferPurchaseState(...a),
  linkOrCreateContactForPurchase: (...a) => linkOrCreateContactForPurchase(...a),
  notifyStaffOfPaidPurchase: (...a) => notifyStaffOfPaidPurchase(...a),
}))

const state = { row: null }
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from() { return this }, select() { return this }, eq() { return this },
    maybeSingle: async () => ({ data: state.row }),
  }),
}))

import { GET } from './route'

const props = { params: Promise.resolve({ id: 'p1' }) }

beforeEach(() => {
  getOrder.mockClear(); markOfferPurchaseState.mockClear()
  linkOrCreateContactForPurchase.mockClear(); notifyStaffOfPaidPurchase.mockClear()
  checkRateLimit.mockClear(); checkRateLimit.mockResolvedValue({ allowed: true })
  state.row = null
})

describe('GET /api/public/offer-purchases/[id]', () => {
  it('404 unknown id', async () => {
    expect((await GET(new Request('http://t'), props)).status).toBe(404)
  })
  it('paid row → { paid: true } with no PII', async () => {
    state.row = { id: 'p1', state: 'paid', revolut_order_id: 'ord_1', offer: { name: 'x' } }
    const json = await (await GET(new Request('http://t'), props)).json()
    expect(json).toEqual({ success: true, data: { paid: true, state: 'paid' } })
  })
  it('created row → provider recheck flips it to paid and runs the paid side-effects', async () => {
    state.row = { id: 'p1', state: 'created', revolut_order_id: 'ord_1', offer: { name: 'x' } }
    const json = await (await GET(new Request('http://t'), props)).json()
    expect(getOrder).toHaveBeenCalledWith('ord_1')
    expect(markOfferPurchaseState).toHaveBeenCalledWith(expect.objectContaining({ providerState: 'completed' }))
    expect(linkOrCreateContactForPurchase).toHaveBeenCalled()
    expect(notifyStaffOfPaidPurchase).toHaveBeenCalled()
    expect(json.data.paid).toBe(true)
  })
  it('recheck is rate-capped: over budget returns the cached state untouched', async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false })
    state.row = { id: 'p1', state: 'created', revolut_order_id: 'ord_1', offer: { name: 'x' } }
    const json = await (await GET(new Request('http://t'), props)).json()
    expect(getOrder).not.toHaveBeenCalled()
    expect(json.data.paid).toBe(false)
  })
  it('side-effect failure never fails the response', async () => {
    linkOrCreateContactForPurchase.mockRejectedValueOnce(new Error('boom'))
    state.row = { id: 'p1', state: 'created', revolut_order_id: 'ord_1', offer: { name: 'x' } }
    const res = await GET(new Request('http://t'), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data.paid).toBe(true)
  })
})
