import { describe, it, expect } from 'vitest'
import { registrationPaidCents } from './race-cancel.js'

// Minimal thenable db mock: db.from(t).select(c).eq(col,val).limit(n) -> { data }
function mockDb(rows) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    limit: () => Promise.resolve({ data: rows }),
  }
  return { from: () => builder }
}

describe('registrationPaidCents', () => {
  // Regression: the filter used to compare status === 'paid', but the
  // race_payments CHECK constraint forbids 'paid' — free + Revolut-completed
  // entries both store 'completed'. So it always summed an empty set and
  // returned 0, which made Mia auto-cancel PAID race entries (action 'direct')
  // instead of routing them to the human refund-approval queue (action 'draft').
  it('sums only completed payments', async () => {
    const db = mockDb([
      { amount_cents: 1000, status: 'completed' },
      { amount_cents: 500, status: 'completed' },
      { amount_cents: 999, status: 'pending' },
      { amount_cents: 999, status: 'failed' },
      { amount_cents: 999, status: 'refunded' },
      { amount_cents: 999, status: 'abandoned' },
    ])
    expect(await registrationPaidCents(db, 'reg1')).toBe(1500)
  })

  it('is case-insensitive on status', async () => {
    const db = mockDb([{ amount_cents: 2500, status: 'COMPLETED' }])
    expect(await registrationPaidCents(db, 'reg1')).toBe(2500)
  })

  it('returns 0 when there are no completed rows', async () => {
    const db = mockDb([{ amount_cents: 1000, status: 'pending' }])
    expect(await registrationPaidCents(db, 'reg1')).toBe(0)
  })

  it('returns 0 on an empty / null result', async () => {
    expect(await registrationPaidCents(mockDb([]), 'reg1')).toBe(0)
    expect(await registrationPaidCents(mockDb(null), 'reg1')).toBe(0)
  })
})
