import { describe, it, expect } from 'vitest'
import { nettedOutByRetry } from './glofox-arrears'

// ARREARS-NETTING.1 — the shared pure helper both the live Overdue feature
// (churn-radar-data fetchPastDue) and the arrears tool reason about.
//
// Glofox cuts a NEW invoice per payment ATTEMPT for one-off purchases. A
// failed attempt orphans as a PAST_DUE `glofox_invoices` row; the eventual
// success is a separate PAID row with a different id. A PAST_DUE row whose
// member (glofox_user_id) has a PAID row of the same amount_cents within
// ±1 day is a settled retry → net it out.
//
// Rows are the `glofox_invoices` shape:
//   { id, glofox_user_id, amount_cents, invoice_date, status }

function pastDue({ id, glofox_user_id = 'u', amount_cents, invoice_date = '2026-05-27T10:36:00Z' }) {
  return { id, glofox_user_id, amount_cents, invoice_date, status: 'PAST_DUE' }
}
function paid({ id, glofox_user_id = 'u', amount_cents, invoice_date = '2026-05-27T10:38:00Z' }) {
  return { id, glofox_user_id, amount_cents, invoice_date, status: 'PAID' }
}

describe('nettedOutByRetry', () => {
  it('excludes a PAST_DUE row matched by a same-member same-amount PAID within the retry window', () => {
    const pd = [pastDue({ id: 'pd1', amount_cents: 2500 })]
    const paidRows = [paid({ id: 'p1', amount_cents: 2500, invoice_date: '2026-05-27T10:38:00Z' })]
    const { kept, nettedIds } = nettedOutByRetry(pd, paidRows)
    expect(kept).toHaveLength(0)
    expect(nettedIds.has('pd1')).toBe(true)
  })

  it('keeps a PAST_DUE row whose only same-amount PAID is 10 days away (window respected)', () => {
    const pd = [pastDue({ id: 'pd1', amount_cents: 2500, invoice_date: '2026-05-01T10:00:00Z' })]
    const paidRows = [paid({ id: 'p1', amount_cents: 2500, invoice_date: '2026-05-11T10:00:00Z' })]
    const { kept, nettedIds } = nettedOutByRetry(pd, paidRows)
    expect(kept.map((r) => r.id)).toEqual(['pd1'])
    expect(nettedIds.size).toBe(0)
  })

  it('keeps a PAST_DUE row when the in-window PAID is a different amount', () => {
    const pd = [pastDue({ id: 'pd1', amount_cents: 2500 })]
    const paidRows = [paid({ id: 'p1', amount_cents: 4000 })]
    const { kept } = nettedOutByRetry(pd, paidRows)
    expect(kept.map((r) => r.id)).toEqual(['pd1'])
  })

  it('does not net across different members', () => {
    const pd = [pastDue({ id: 'pd1', glofox_user_id: 'alice', amount_cents: 2500 })]
    const paidRows = [paid({ id: 'p1', glofox_user_id: 'bob', amount_cents: 2500 })]
    const { kept } = nettedOutByRetry(pd, paidRows)
    expect(kept.map((r) => r.id)).toEqual(['pd1'])
  })

  it('consumes a PAID one-to-one — one retry settles only one of two identical PAST_DUE rows', () => {
    const pd = [
      pastDue({ id: 'pd1', amount_cents: 2500, invoice_date: '2026-05-27T10:36:00Z' }),
      pastDue({ id: 'pd2', amount_cents: 2500, invoice_date: '2026-05-27T11:00:00Z' }),
    ]
    const paidRows = [paid({ id: 'p1', amount_cents: 2500, invoice_date: '2026-05-27T10:38:00Z' })]
    const { kept, nettedIds } = nettedOutByRetry(pd, paidRows)
    expect(kept).toHaveLength(1)
    expect(nettedIds.size).toBe(1)
  })

  it('nets exactly at the ±1 day boundary (inclusive)', () => {
    const pd = [pastDue({ id: 'pd1', amount_cents: 2500, invoice_date: '2026-05-01T00:00:00Z' })]
    const paidRows = [paid({ id: 'p1', amount_cents: 2500, invoice_date: '2026-05-02T00:00:00Z' })] // exactly 1 day
    const { kept } = nettedOutByRetry(pd, paidRows)
    expect(kept).toHaveLength(0)
  })

  it('does NOT net a same-amount PAID 48h away (a real separate fee, not a retry — the Tara Diggin case)', () => {
    const pd = [pastDue({ id: 'pd1', amount_cents: 1000, invoice_date: '2026-01-30T15:24:00Z' })]
    const paidRows = [paid({ id: 'p1', amount_cents: 1000, invoice_date: '2026-01-28T15:21:00Z' })] // 48h earlier = different fee
    const { kept } = nettedOutByRetry(pd, paidRows)
    expect(kept.map((r) => r.id)).toEqual(['pd1'])
  })

  it('returns all rows untouched when there are no paid rows', () => {
    const pd = [pastDue({ id: 'pd1', amount_cents: 2500 }), pastDue({ id: 'pd2', amount_cents: 4000 })]
    const { kept, nettedIds } = nettedOutByRetry(pd, [])
    expect(kept).toHaveLength(2)
    expect(nettedIds.size).toBe(0)
  })

  it('ignores PAST_DUE rows with no glofox_user_id (can not be matched)', () => {
    const pd = [pastDue({ id: 'pd1', glofox_user_id: null, amount_cents: 2500 })]
    const paidRows = [paid({ id: 'p1', glofox_user_id: null, amount_cents: 2500 })]
    const { kept } = nettedOutByRetry(pd, paidRows)
    expect(kept.map((r) => r.id)).toEqual(['pd1'])
  })
})
