// Route-level tests for the race-payments Revolut webhook — the sibling of
// the cars deposit webhook. Same contract: a re-delivery is a no-op, a
// terminal state isn't reprocessed, and confirmations fire exactly once on a
// FRESH completion. The state→payment mapping lives in markRacePaymentStatus
// (lib, tested separately); here we pin the route's orchestration + the
// "confirmations only on fresh completed" guard.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/revolut', () => ({ verifyWebhookSignature: vi.fn(), getOrder: vi.fn() }))
vi.mock('@/lib/race-payments', () => ({
  resolveRacePaymentByProviderRef: vi.fn(),
  markRacePaymentStatus: vi.fn(),
}))
vi.mock('@/lib/race-confirmations', () => ({ sendRaceConfirmations: vi.fn(async () => ({ sent: ['email'] })) }))
vi.mock('@/lib/webhook-events', () => ({
  recordWebhookEvent: vi.fn(async () => ({ seen: false })),
  WEBHOOK_PROVIDERS: { REVOLUT_RACE: 'revolut_race' },
}))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import { resolveRacePaymentByProviderRef, markRacePaymentStatus } from '@/lib/race-payments'
import { sendRaceConfirmations } from '@/lib/race-confirmations'
import { recordWebhookEvent } from '@/lib/webhook-events'

// Minimal DB mock — only the fire-and-forget Glofox IIFE touches it, and it
// bails early when the race_payments lookup returns null (no create_in_glofox).
function makeDb() {
  const b = {
    from: () => b, select: () => b, eq: () => b,
    maybeSingle: () => Promise.resolve({ data: null }),
    then: (resolve) => resolve({ data: null, error: null }),
  }
  return b
}

function makeRequest({ body = JSON.stringify({ event: 'ORDER_COMPLETED', order_id: 'ord-9' }) } = {}) {
  return {
    text: async () => body,
    headers: { get: (k) => ({ 'revolut-signature': 'v1=s', 'revolut-request-timestamp': '1' }[k.toLowerCase()] ?? null) },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyWebhookSignature.mockReturnValue(true)
  recordWebhookEvent.mockResolvedValue({ seen: false })
  createServerClient.mockReturnValue(makeDb())
  resolveRacePaymentByProviderRef.mockResolvedValue({ id: 'pay-1' })
  getOrder.mockResolvedValue({ state: 'completed', amount: 5000 })
  markRacePaymentStatus.mockResolvedValue({ applied: { status: 'completed' } })
})

describe('POST /api/webhooks/revolut/race-payments', () => {
  it('invalid signature → 401, no DB', async () => {
    verifyWebhookSignature.mockReturnValue(false)
    const res = await POST(makeRequest())
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('empty body → 200 (verification ping)', async () => {
    const res = await POST(makeRequest({ body: '' }))
    expect(res.status).toBe(200)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('missing order_id/event → 200 before DB', async () => {
    const res = await POST(makeRequest({ body: JSON.stringify({ event: 'X' }) }))
    expect(res.status).toBe(200)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('DEDUP: re-delivery → 200 deduped, never marks the payment', async () => {
    recordWebhookEvent.mockResolvedValue({ seen: true })
    const res = await POST(makeRequest())
    const body = await res.json()
    expect(body.deduped).toBe(true)
    expect(markRacePaymentStatus).not.toHaveBeenCalled()
    expect(getOrder).not.toHaveBeenCalled()
  })

  it('unknown payment → 200 skipped, no getOrder, no mark', async () => {
    resolveRacePaymentByProviderRef.mockResolvedValue(null)
    const res = await POST(makeRequest())
    const body = await res.json()
    expect(body.skipped).toBe('unknown_order')
    expect(getOrder).not.toHaveBeenCalled()
    expect(markRacePaymentStatus).not.toHaveBeenCalled()
  })

  it('getOrder failure → 200 skipped, payment not marked', async () => {
    getOrder.mockRejectedValue(new Error('revolut down'))
    const res = await POST(makeRequest())
    const body = await res.json()
    expect(body.skipped).toBe('getorder_failed')
    expect(markRacePaymentStatus).not.toHaveBeenCalled()
  })

  it('fresh completion → marks payment + fires confirmations once', async () => {
    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(markRacePaymentStatus).toHaveBeenCalledTimes(1)
    expect(sendRaceConfirmations).toHaveBeenCalledTimes(1)
    expect(sendRaceConfirmations).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'pay-1' }))
  })

  it('IDEMPOTENCY: an already-completed payment (mark returns no fresh status) does NOT re-send confirmations', async () => {
    markRacePaymentStatus.mockResolvedValue({ applied: { status: 'unchanged' } })
    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(sendRaceConfirmations).not.toHaveBeenCalled()
  })

  it('non-terminal state (authorised) → marks but does not confirm', async () => {
    getOrder.mockResolvedValue({ state: 'authorised', amount: 5000 })
    markRacePaymentStatus.mockResolvedValue({ applied: { status: 'authorised' } })
    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(markRacePaymentStatus).toHaveBeenCalledTimes(1)
    expect(sendRaceConfirmations).not.toHaveBeenCalled()
  })
})
