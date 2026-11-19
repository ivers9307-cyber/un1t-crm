// ORDERSTRIALS.1 — paid trials and offers in orders. A Revolut or Stripe one
// refunds through the provider like any order and changes nothing on the
// trial or offer (Richard's decision, 19 Nov 2026); a un1t.online one never
// moves money from the CRM: it files the record-only refund card instead.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/revolut', () => ({ RevolutError: class RevolutError extends Error {} }))
const refundPayment = vi.fn()
vi.mock('@/lib/payments', () => ({ paymentsFor: vi.fn(() => ({ refundPayment })) }))
vi.mock('@/lib/contact-events', () => ({ emitEvent: vi.fn(async () => {}), applyTagRules: vi.fn(async () => {}), EVENT_TYPES: { ORDER_REFUNDED: 'order.refunded' } }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logInfo: vi.fn() }))
const fileRefundCard = vi.fn()
vi.mock('@/lib/un1t-online-approval', () => ({ fileRefundCard: (...a) => fileRefundCard(...a) }))
const markDonationRefunded = vi.fn(async () => ({ changed: true }))
vi.mock('@/lib/donation-payments', () => ({ markDonationRefunded: (...a) => markDonationRefunded(...a) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const owner = {
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role: 'owner', profileRole: 'owner',
  activeLocation: { id: L1 },
  rolesByLocation: { [L1]: 'owner' },
  assignmentsByLocation: { [L1]: { role: 'owner', permissions: { orders: true } } },
  locations: [{ id: L1, role: 'owner', features: { orders: true } }],
}
const BASE = {
  id: 'o1', status: 'completed', amount_cents: 3900, refunded_amount_cents: 0, currency: 'EUR',
  location_id: L1, contact_id: 'c1', contact_email: 'a@x.ie',
}

function fakeDb(order, { sourceRow = { un1t_user_id: 'un1t-u9' } } = {}) {
  const calls = []
  const rpcs = []
  return {
    calls, rpcs,
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const b = {}
      for (const n of ['select', 'eq', 'update']) b[n] = (...a) => { q.ops.push([n, ...a]); return b }
      b.single = async () => ({ data: order, error: null })
      b.maybeSingle = async () => ({ data: sourceRow, error: null })
      b.then = (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej)
      return b
    },
    async rpc(name, args) {
      rpcs.push([name, args])
      if (name === 'claim_order_refund') {
        return { data: { ok: true, resumed: false, refund_id: 'r1', amount_cents: 3900, idempotency_key: 'refund:o1:r1', is_full: true }, error: null }
      }
      if (name === 'finish_order_refund') return { data: { ok: true, refunded_total_cents: 3900, is_full: true }, error: null }
      return { data: null, error: { message: `unexpected rpc ${name}` } }
    },
  }
}
const post = (body = { reason: 'Changed their mind' }) => POST(new Request('http://localhost/api/orders/o1/refund', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: 'o1' }) })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(owner)
  refundPayment.mockResolvedValue({ refundId: 'rf1' })
  fileRefundCard.mockResolvedValue({ approvalId: 'card-1' })
})

describe('refunding a paid trial or offer', () => {
  it.each(['trial_purchase', 'offer_purchase'])('a Revolut %s refunds through the provider and writes nothing to its source row', async (sourceType) => {
    const db = fakeDb({ ...BASE, source_type: sourceType, source_id: 's1', payment_provider: 'revolut', payment_provider_ref: 'rev-1' })
    createServerClient.mockReturnValue(db)
    const res = await post()
    expect(res.status).toBe(200)
    expect(refundPayment).toHaveBeenCalledWith('rev-1', expect.objectContaining({ amountCents: 3900, idempotencyKey: 'refund:o1:r1' }))
    expect(db.calls.filter((c) => c.ops.some(([op]) => op === 'update'))).toEqual([])
    expect(fileRefundCard).not.toHaveBeenCalled()
  })

  it('a un1t.online sale files a refund card and moves no money', async () => {
    const db = fakeDb({ ...BASE, source_type: 'offer_purchase', source_id: 's2', payment_provider: 'un1t_online', payment_provider_ref: 'tx-9' })
    createServerClient.mockReturnValue(db)
    const res = await post({ amount_cents: 2000, reason: 'Double charged' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ order_id: 'o1', refund_card_id: 'card-1', refund_in: 'un1t_online' })
    expect(refundPayment).not.toHaveBeenCalled()
    expect(db.rpcs).toEqual([])
    expect(fileRefundCard).toHaveBeenCalledWith(db, expect.objectContaining({
      locationId: L1, contactId: 'c1', un1tUserId: 'un1t-u9', reason: 'member_request', transactionIds: ['tx-9'],
      amountCents: 2000, origin: 'staff', originRef: 'o1', note: 'Double charged',
    }))
    expect(db.calls.find((c) => c.table === 'offer_purchases')).toBeTruthy()
  })

  it('a un1t.online card that could not be filed says nothing was refunded', async () => {
    fileRefundCard.mockResolvedValue({ approvalId: null })
    createServerClient.mockReturnValue(fakeDb({ ...BASE, source_type: 'trial_purchase', source_id: 's3', payment_provider: 'un1t_online', payment_provider_ref: 'tx-1' }))
    const res = await post()
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/Nothing was refunded/)
  })

  it('a un1t.online order that is not completed is refused before any card', async () => {
    createServerClient.mockReturnValue(fakeDb({ ...BASE, status: 'refunded', source_type: 'trial_purchase', source_id: 's3', payment_provider: 'un1t_online' }))
    const res = await post()
    expect(res.status).toBe(409)
    expect(fileRefundCard).not.toHaveBeenCalled()
  })

  // ORDERSMORE.1
  it('a full donation refund marks the donation refunded, by the person who refunded it', async () => {
    createServerClient.mockReturnValue(fakeDb({ ...BASE, source_type: 'donation', source_id: 'd1', payment_provider: 'revolut', payment_provider_ref: 'rev-d' }))
    const res = await post()
    expect(res.status).toBe(200)
    expect(markDonationRefunded).toHaveBeenCalledWith(expect.objectContaining({ donationId: 'd1', byProfileId: 'u1' }))
  })

  it('a donation that could not be marked refunded is logged; the refund still stands', async () => {
    markDonationRefunded.mockRejectedValueOnce(new Error('db down'))
    createServerClient.mockReturnValue(fakeDb({ ...BASE, source_type: 'donation', source_id: 'd1', payment_provider: 'revolut', payment_provider_ref: 'rev-d' }))
    const res = await post()
    expect(res.status).toBe(200)
  })

  it.each([['staff_payment_link', 'staff_payment_links'], ['class_fee', 'class_fees']])('a un1t.online %s files a refund card, reading the buyer from %s', async (sourceType, table) => {
    const db = fakeDb({ ...BASE, source_type: sourceType, source_id: 's9', payment_provider: 'un1t_online', payment_provider_ref: 'tx-9' })
    createServerClient.mockReturnValue(db)
    const res = await post()
    expect(res.status).toBe(200)
    expect(refundPayment).not.toHaveBeenCalled()
    expect(fileRefundCard).toHaveBeenCalledWith(db, expect.objectContaining({ un1tUserId: 'un1t-u9', transactionIds: ['tx-9'], originRef: 'o1' }))
    expect(db.calls.find((c) => c.table === table)).toBeTruthy()
  })
})
