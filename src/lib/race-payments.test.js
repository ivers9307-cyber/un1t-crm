// Tests for src/lib/race-payments.js (mig 084).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the Revolut HTTP client BEFORE importing the SUT — the real
// module reads env vars at import time and we don't want to need
// REVOLUT_API_KEY set for a unit test.
vi.mock('./revolut', () => ({
  createOrder: vi.fn(),
  getOrder: vi.fn(),
}))

import { createOrder } from './revolut'
import { createRacePayment, markRacePaymentStatus } from './race-payments'

// Minimal Supabase chain mock — captures inserts/updates so tests can
// assert what was written.
function makeDb({ insertedRow = { id: 'pay-1' } } = {}) {
  const ops = { inserts: [], updates: [] }
  const tableShim = (table) => ({
    insert: (row) => {
      ops.inserts.push({ table, row })
      return {
        select: () => ({
          single: async () => ({ data: { ...insertedRow, ...row }, error: null }),
        }),
      }
    },
    update: (patch) => {
      const u = { table, patch, where: {} }
      ops.updates.push(u)
      return {
        eq: (col, val) => {
          u.where[col] = val
          return Promise.resolve({ data: null, error: null })
        },
      }
    },
  })
  return {
    from: (table) => tableShim(table),
    _ops: ops,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createRacePayment — free entry', () => {
  it('skips Revolut when amount is 0 and marks payment + registration completed', async () => {
    const db = makeDb()
    const r = await createRacePayment({
      db,
      race: { id: 'race-1', name: 'Hyrox Sim', payment_currency: 'EUR' },
      registration: { id: 'reg-1', contact_id: 'c-1' },
      captain: { name: 'Sarah', email: 'sarah@example.com', phone: null },
      pricing: {
        total_cents: 0,
        member_count: 2,
        non_member_count: 0,
        member_fee_cents: null,
        non_member_fee_cents: null,
      },
      returnUrl: 'https://example.com/back',
    })
    expect(createOrder).not.toHaveBeenCalled()
    expect(r.checkout.free).toBe(true)
    expect(r.checkout.token).toBeNull()
    // race_payments insert + race_registrations update both fired.
    const inserts = db._ops.inserts.filter((x) => x.table === 'race_payments')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].row.status).toBe('completed')
    expect(inserts[0].row.amount_cents).toBe(0)
    const regUpdate = db._ops.updates.find((u) => u.table === 'race_registrations')
    expect(regUpdate.patch.status).toBe('confirmed')
  })
})

describe('createRacePayment — paid entry', () => {
  it('creates a Revolut order and returns the checkout token', async () => {
    createOrder.mockResolvedValue({
      id: 'rev-order-uuid',
      token: 'rev-token-abc',
      checkout_url: 'https://merchant.revolut.com/order/rev-order-uuid',
    })
    const db = makeDb()
    const r = await createRacePayment({
      db,
      race: { id: 'race-1', name: 'Hyrox Sim', payment_currency: 'EUR' },
      registration: { id: 'reg-1', contact_id: 'c-1' },
      captain: { name: 'Sarah', email: 'sarah@example.com', phone: '+353871234567' },
      pricing: {
        total_cents: 5000,
        member_count: 0,
        non_member_count: 2,
        member_fee_cents: null,
        non_member_fee_cents: 2500,
      },
      returnUrl: 'https://example.com/back',
    })
    expect(createOrder).toHaveBeenCalledTimes(1)
    expect(createOrder.mock.calls[0][0]).toMatchObject({
      amount: 5000,
      currency: 'EUR',
      idempotencyKey: 'reg-1',
    })
    // Idempotency key prevents double-charging on register-route retry.
    expect(r.checkout.free).toBe(false)
    expect(r.checkout.token).toBe('rev-token-abc')
    const inserts = db._ops.inserts.filter((x) => x.table === 'race_payments')
    expect(inserts[0].row.status).toBe('pending')
    expect(inserts[0].row.payment_provider).toBe('revolut')
    expect(inserts[0].row.payment_provider_ref).toBe('rev-order-uuid')
  })
})

describe('markRacePaymentStatus', () => {
  function makeUpdateDb() {
    const updates = []
    return {
      from: (table) => ({
        update: (patch) => ({
          eq: (col, val) => {
            updates.push({ table, patch, col, val })
            return {
              eq: (col2, val2) => {
                const last = updates[updates.length - 1]
                last.col2 = col2
                last.val2 = val2
                return Promise.resolve({ data: null, error: null })
              },
              then: (cb) => cb({ data: null, error: null }),
            }
          },
        }),
      }),
      _updates: updates,
    }
  }

  it('marks completed and flips registration to confirmed', async () => {
    const db = makeUpdateDb()
    const result = await markRacePaymentStatus({
      db,
      payment: { id: 'pay-1', status: 'pending', race_registration_id: 'reg-1', amount_cents: 5000 },
      revolutState: 'completed',
      revolutAmount: 5000,
    })
    expect(result.state_changed).toBe(true)
    expect(result.applied.status).toBe('completed')
    const paymentUpdate = db._updates.find((u) => u.table === 'race_payments')
    expect(paymentUpdate.patch.status).toBe('completed')
    const regUpdate = db._updates.find((u) => u.table === 'race_registrations')
    expect(regUpdate.patch.status).toBe('confirmed')
  })

  it('is idempotent — re-completing does nothing', async () => {
    const db = makeUpdateDb()
    const result = await markRacePaymentStatus({
      db,
      payment: { id: 'pay-1', status: 'completed', race_registration_id: 'reg-1', amount_cents: 5000 },
      revolutState: 'completed',
      revolutAmount: 5000,
    })
    expect(result.state_changed).toBe(false)
    expect(result.applied).toBeNull()
  })

  it('treats Revolut cancelled as our abandoned', async () => {
    const db = makeUpdateDb()
    const result = await markRacePaymentStatus({
      db,
      payment: { id: 'pay-1', status: 'pending', race_registration_id: 'reg-1', amount_cents: 5000 },
      revolutState: 'cancelled',
      revolutAmount: null,
    })
    expect(result.applied.status).toBe('abandoned')
  })

  it('ignores transient states', async () => {
    const db = makeUpdateDb()
    const result = await markRacePaymentStatus({
      db,
      payment: { id: 'pay-1', status: 'pending', amount_cents: 5000 },
      revolutState: 'authorised',
      revolutAmount: null,
    })
    expect(result.state_changed).toBe(false)
  })
})
