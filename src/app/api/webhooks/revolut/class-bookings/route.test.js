// REVPAY.1 — the class-bookings Revolut webhook (paid class-funnel intros and,
// on the same endpoint, paid trial purchases). Pins: an order that is not ours
// takes no dedupe claim; a deferral after the claim releases it; a mark that
// landed never releases it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/revolut', () => ({ verifyWebhookSignature: vi.fn(), getOrder: vi.fn() }))
vi.mock('@/lib/class-booking-payments', () => ({
  resolveClassBookingPaymentByRef: vi.fn(),
  markClassBookingPaymentStatus: vi.fn(),
}))
vi.mock('@/lib/trial-purchase-payments', () => ({
  resolveTrialPurchaseByRef: vi.fn(),
  markTrialPurchasePaymentStatus: vi.fn(),
}))
vi.mock('@/lib/qstash', () => ({
  publishQueuePush: vi.fn(async () => {}),
  CLASS_BOOKINGS_WORKER_PATH: '/w/class',
  TRIAL_PURCHASES_WORKER_PATH: '/w/trial',
}))
vi.mock('@/lib/webhook-events', () => ({
  recordWebhookEvent: vi.fn(),
  releaseWebhookEvent: vi.fn(async () => {}),
  WEBHOOK_PROVIDERS: { REVOLUT_CLASS_BOOKING: 'revolut_class_booking' },
}))

import { POST, GET } from './route.js'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import { resolveClassBookingPaymentByRef, markClassBookingPaymentStatus } from '@/lib/class-booking-payments'
import { resolveTrialPurchaseByRef, markTrialPurchasePaymentStatus } from '@/lib/trial-purchase-payments'
import { publishQueuePush } from '@/lib/qstash'
import { recordWebhookEvent, releaseWebhookEvent } from '@/lib/webhook-events'

function makeRequest(body = JSON.stringify({ event: 'ORDER_COMPLETED', order_id: 'ord-1' })) {
  return {
    text: async () => body,
    headers: { get: (k) => ({ 'revolut-signature': 'v1=s', 'revolut-request-timestamp': '1' }[k.toLowerCase()] ?? null) },
  }
}
const ROW = { id: 'cb1', status: 'awaiting_payment', payment_status: 'pending' }
const TRIAL = { id: 'tp1', status: 'awaiting_payment', payment_status: 'pending' }
const CLAIM = { provider: 'revolut_class_booking', eventId: 'ORDER_COMPLETED:ord-1' }

beforeEach(() => {
  vi.clearAllMocks()
  verifyWebhookSignature.mockReturnValue(true)
  recordWebhookEvent.mockResolvedValue({ seen: false })
  resolveClassBookingPaymentByRef.mockResolvedValue(ROW)
  resolveTrialPurchaseByRef.mockResolvedValue(null)
  getOrder.mockResolvedValue({ state: 'completed', amount: 1500 })
  markClassBookingPaymentStatus.mockResolvedValue({ released: true })
  markTrialPurchasePaymentStatus.mockResolvedValue({ released: true })
})

describe('POST /api/webhooks/revolut/class-bookings', () => {
  it('401 on a bad signature', async () => {
    verifyWebhookSignature.mockReturnValue(false)
    expect((await POST(makeRequest())).status).toBe(401)
  })

  it('an order that is neither a class booking nor a trial → 200 skipped, no claim, no getOrder', async () => {
    resolveClassBookingPaymentByRef.mockResolvedValue(null)
    const res = await POST(makeRequest())
    expect((await res.json()).skipped).toBe('unknown_order')
    expect(recordWebhookEvent).not.toHaveBeenCalled()
    expect(getOrder).not.toHaveBeenCalled()
  })

  it('both lookups are strict and run before the claim', async () => {
    resolveClassBookingPaymentByRef.mockResolvedValue(null)
    resolveTrialPurchaseByRef.mockResolvedValue(TRIAL)
    await POST(makeRequest())
    expect(resolveClassBookingPaymentByRef).toHaveBeenCalledWith(expect.anything(), 'ord-1', { throwOnError: true })
    expect(resolveTrialPurchaseByRef).toHaveBeenCalledWith(expect.anything(), 'ord-1', { throwOnError: true })
    expect(resolveTrialPurchaseByRef.mock.invocationCallOrder[0]).toBeLessThan(recordWebhookEvent.mock.invocationCallOrder[0])
  })

  it('a failed lookup defers with nothing claimed', async () => {
    resolveClassBookingPaymentByRef.mockRejectedValue(new Error('db down'))
    const res = await POST(makeRequest())
    expect((await res.json()).deferred).toBe(true)
    expect(recordWebhookEvent).not.toHaveBeenCalled()
    expect(releaseWebhookEvent).not.toHaveBeenCalled()
  })

  it('a re-delivery is deduped and never marks', async () => {
    recordWebhookEvent.mockResolvedValue({ seen: true })
    const res = await POST(makeRequest())
    expect((await res.json()).deduped).toBe(true)
    expect(markClassBookingPaymentStatus).not.toHaveBeenCalled()
  })

  describe('class booking branch', () => {
    it('fresh completion releases the booking and nudges the queue; claim kept', async () => {
      const res = await POST(makeRequest())
      expect((await res.json()).released).toBe(true)
      expect(publishQueuePush).toHaveBeenCalledWith(expect.objectContaining({ path: '/w/class', body: { id: 'cb1' } }))
      expect(releaseWebhookEvent).not.toHaveBeenCalled()
    })

    it('getOrder failure → deferred, claim released, no mark', async () => {
      getOrder.mockRejectedValue(new Error('revolut down'))
      const res = await POST(makeRequest())
      expect((await res.json()).deferred).toBe(true)
      expect(releaseWebhookEvent).toHaveBeenCalledWith(expect.objectContaining(CLAIM))
      expect(markClassBookingPaymentStatus).not.toHaveBeenCalled()
    })

    it('a failed status write (mark returns error) → deferred, claim released, no queue nudge', async () => {
      markClassBookingPaymentStatus.mockResolvedValue({ released: false, error: { message: 'down' } })
      const res = await POST(makeRequest())
      expect(res.status).toBe(200)
      expect((await res.json()).deferred).toBe(true)
      expect(releaseWebhookEvent).toHaveBeenCalledWith(expect.objectContaining(CLAIM))
      expect(publishQueuePush).not.toHaveBeenCalled()
    })

    it('a thrown mark → deferred, claim released', async () => {
      markClassBookingPaymentStatus.mockRejectedValue(new Error('boom'))
      const res = await POST(makeRequest())
      expect((await res.json()).deferred).toBe(true)
      expect(releaseWebhookEvent).toHaveBeenCalledTimes(1)
    })

    it('a queue nudge that throws after a landed mark never releases the claim', async () => {
      publishQueuePush.mockRejectedValueOnce(new Error('qstash down'))
      const res = await POST(makeRequest())
      expect(res.status).toBe(200)
      expect(releaseWebhookEvent).not.toHaveBeenCalled()
    })
  })

  describe('trial purchase branch', () => {
    beforeEach(() => {
      resolveClassBookingPaymentByRef.mockResolvedValue(null)
      resolveTrialPurchaseByRef.mockResolvedValue(TRIAL)
    })

    it('fresh completion releases the trial and nudges its worker; claim kept', async () => {
      const json = await (await POST(makeRequest())).json()
      expect(json).toMatchObject({ released: true, domain: 'trial_purchase' })
      expect(publishQueuePush).toHaveBeenCalledWith(expect.objectContaining({ path: '/w/trial', body: { id: 'tp1' } }))
      expect(releaseWebhookEvent).not.toHaveBeenCalled()
    })

    it('getOrder failure → deferred, claim released', async () => {
      getOrder.mockRejectedValue(new Error('revolut down'))
      const json = await (await POST(makeRequest())).json()
      expect(json.deferred).toBe(true)
      expect(releaseWebhookEvent).toHaveBeenCalledWith(expect.objectContaining(CLAIM))
      expect(markTrialPurchasePaymentStatus).not.toHaveBeenCalled()
    })

    it('a thrown status write → deferred, claim released, no nudge', async () => {
      markTrialPurchasePaymentStatus.mockRejectedValue({ message: 'write failed' })
      const json = await (await POST(makeRequest())).json()
      expect(json.deferred).toBe(true)
      expect(releaseWebhookEvent).toHaveBeenCalledTimes(1)
      expect(publishQueuePush).not.toHaveBeenCalled()
    })
  })
})

describe('GET', () => {
  it('200 for Revolut URL validation', async () => {
    expect((await GET()).status).toBe(200)
  })
})
