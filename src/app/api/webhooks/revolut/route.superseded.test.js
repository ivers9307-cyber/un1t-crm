// DEPOSITREISSUE.1 — an order no car holds may be one a re-issued deposit link
// superseded; the webhook settles it instead of skipping it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/revolut', () => ({ verifyWebhookSignature: () => true, getOrder: vi.fn() }))
vi.mock('@/lib/webhook-events', () => ({ recordWebhookEvent: vi.fn(), releaseWebhookEvent: vi.fn(), WEBHOOK_PROVIDERS: { REVOLUT: 'revolut' } }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/car-deposit-revolut', () => ({ depositUpdateForOrder: vi.fn(), applyCarDepositUpdates: vi.fn(), settleSupersededOrder: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({ from: () => { const q = {}; q.select = () => q; q.eq = () => q; q.maybeSingle = async () => ({ data: null, error: null }); return q } }),
}))

const { POST } = await import('./route.js')
const { settleSupersededOrder } = await import('@/lib/car-deposit-revolut')
const post = () => POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ event: 'ORDER_COMPLETED', order_id: 'o-old' }) }))

beforeEach(() => vi.clearAllMocks())

describe('POST /api/webhooks/revolut — superseded deposit orders', () => {
  it('settles an order a re-issue superseded', async () => {
    settleSupersededOrder.mockResolvedValue({ outcome: 'settled', state: 'completed' })
    const body = await (await post()).json()
    expect(body).toMatchObject({ success: true, superseded: 'settled' })
    expect(settleSupersededOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o-old' }))
  })

  it('an order nobody superseded is still skipped as another flow\'s', async () => {
    settleSupersededOrder.mockResolvedValue({ outcome: 'not_superseded' })
    expect((await (await post()).json()).skipped).toBe('unknown_order')
  })

  it('a throw answers 200 deferred (the reconcile catches it)', async () => {
    settleSupersededOrder.mockRejectedValue(new Error('boom'))
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).deferred).toBe(true)
  })
})
