import { describe, it, expect } from 'vitest'
import {
  queueRowLifecycle,
  aggregateQueueLifecycles,
  expenseClaimLifecycle,
  latestQueueRowBy,
} from './accountant-queue-lifecycle.js'
import { contractorInvoiceLifecycle } from './contractor-invoice-review.js'

const AWAITING = { status: 'awaiting_accountant_review' }

function row(itemId, extra = {}) {
  return { source_fte_expense_item_id: itemId, status: 'quality_approved', created_at: '2026-09-09T10:00:00Z', ...extra }
}

describe('queueRowLifecycle', () => {
  it('undefined (read failed) is plain Approved, never a guess', () => {
    expect(queueRowLifecycle(undefined).label).toBe('Approved')
  })
  it('null is not yet queued', () => {
    expect(queueRowLifecycle(null).key).toBe('approved_not_queued')
  })
  it.each([
    ['quality_approved', 'queued_for_accountant'],
    ['extracted', 'queued_for_accountant'],
    ['data_approved', 'queued_for_accountant'],
    ['forwarded', 'sent_to_xero'],
    ['rejected', 'rejected_by_accountant'],
  ])('queue status %s → %s', (status, key) => {
    expect(queueRowLifecycle({ status }).key).toBe(key)
  })
  it('a DRAFT Xero bill is Sent to Xero, not Paid', () => {
    expect(queueRowLifecycle({ status: 'forwarded', xero_bill_id: 'b', xero_bill_status: 'DRAFT' }).key).toBe('sent_to_xero')
  })
  it('Paid needs PAID or a paid date', () => {
    expect(queueRowLifecycle({ status: 'forwarded', xero_bill_status: 'paid' }).key).toBe('paid')
    expect(queueRowLifecycle({ status: 'forwarded', xero_bill_paid_at: '2026-09-01' }).key).toBe('paid')
    expect(queueRowLifecycle({ status: 'forwarded', xero_bill_status: 'AUTHORISED' }).key).toBe('sent_to_xero')
  })
  it('voided / deleted bills', () => {
    expect(queueRowLifecycle({ status: 'forwarded', xero_bill_status: 'VOIDED' }).key).toBe('voided_in_xero')
    expect(queueRowLifecycle({ status: 'forwarded', xero_bill_status: 'DELETED' }).key).toBe('voided_in_xero')
  })
})

describe('contractor invoices and expense items share the queue decision', () => {
  const shapes = [
    undefined, null,
    { status: 'quality_approved' },
    { status: 'forwarded', xero_bill_id: 'x', xero_bill_status: 'DRAFT' },
    { status: 'forwarded', xero_bill_status: 'PAID' },
    { status: 'rejected' },
  ]
  it.each(shapes.map((s) => [JSON.stringify(s), s]))('queue %s', (_, q) => {
    const inv = contractorInvoiceLifecycle({ status: 'awaiting_accountant_review' }, q)
    expect(inv).toEqual(queueRowLifecycle(q))
  })
})

describe('latestQueueRowBy', () => {
  it('keeps the newest row per source id', () => {
    const m = latestQueueRowBy([
      row('a', { status: 'rejected', created_at: '2026-01-01' }),
      row('a', { status: 'quality_approved', created_at: '2026-02-01' }),
      { status: 'x' },
    ], 'source_fte_expense_item_id')
    expect(m.get('a').status).toBe('quality_approved')
    expect(m.size).toBe(1)
  })
})

describe('aggregateQueueLifecycles', () => {
  it('uniform items have no detail', () => {
    const a = aggregateQueueLifecycles([{ key: 'sent_to_xero' }, { key: 'sent_to_xero' }])
    expect(a.key).toBe('sent_to_xero')
    expect(a.detail).toBeNull()
  })
  it('mixed items read as the least-advanced, with a breakdown', () => {
    const a = aggregateQueueLifecycles([{ key: 'paid' }, { key: 'queued_for_accountant' }])
    expect(a.label).toBe('Approved, queued for accountant')
    expect(a.detail).toBe('1 of 2 queued for accountant, 1 of 2 paid')
  })
  it('a rejected item outranks progress on its siblings', () => {
    const a = aggregateQueueLifecycles([{ key: 'paid' }, { key: 'rejected_by_accountant' }])
    expect(a.key).toBe('rejected_by_accountant')
  })
  it('empty list is plain Approved', () => {
    expect(aggregateQueueLifecycles([]).label).toBe('Approved')
  })
})

describe('expenseClaimLifecycle', () => {
  it('pre-approval states', () => {
    expect(expenseClaimLifecycle({ status: 'draft' }).label).toBe('Draft')
    expect(expenseClaimLifecycle({ status: 'submitted' }).label).toBe('Awaiting review')
    expect(expenseClaimLifecycle({ status: 'declined' }).tone).toBe('red')
    expect(expenseClaimLifecycle({ status: 'revoked' }).label).toBe('Revoked')
  })

  it('legacy approved claims read from xero_synced_at', () => {
    expect(expenseClaimLifecycle({ status: 'approved' }).label).toBe('Approved')
    expect(expenseClaimLifecycle({ status: 'approved', xero_synced_at: '2026-04-01' }).label).toBe('Sent to Xero')
  })

  it('a failed queue read is plain Approved', () => {
    expect(expenseClaimLifecycle(AWAITING, undefined).label).toBe('Approved')
  })

  it('an item-less claim never reads "not queued"', () => {
    expect(expenseClaimLifecycle(AWAITING, { itemIds: [], rows: [] }).label).toBe('Approved')
  })

  it('items with no queue rows read not yet queued', () => {
    const l = expenseClaimLifecycle(AWAITING, { itemIds: ['a', 'b'], rows: [] })
    expect(l.key).toBe('approved_not_queued')
  })

  // The three prod shapes seen 2026-09-18 (fte_expense_claims joined to
  // invoices_queue via source_fte_expense_item_id).
  it('prod: one receiptless item rejected by the accountant', () => {
    const l = expenseClaimLifecycle(AWAITING, { itemIds: ['i1'], rows: [row('i1', { status: 'rejected' })] })
    expect(l.label).toBe('Approved, rejected by accountant')
  })
  it('prod: one item forwarded, Xero bill DRAFT', () => {
    const l = expenseClaimLifecycle(AWAITING, {
      itemIds: ['i1'],
      rows: [row('i1', { status: 'forwarded', forwarded_at: '2026-08-20', xero_bill_id: 'b1', xero_bill_status: 'DRAFT' })],
    })
    expect(l.label).toBe('Sent to Xero')
  })
  it('prod: two items both waiting for the accountant', () => {
    const l = expenseClaimLifecycle(AWAITING, { itemIds: ['i1', 'i2'], rows: [row('i1'), row('i2')] })
    expect(l.label).toBe('Approved, queued for accountant')
    expect(l.detail).toBeNull()
  })

  it('Paid only when every item is paid', () => {
    const paid = { status: 'forwarded', xero_bill_id: 'b', xero_bill_status: 'PAID' }
    expect(expenseClaimLifecycle(AWAITING, { itemIds: ['a', 'b'], rows: [row('a', paid), row('b', paid)] }).label).toBe('Paid')
    const half = expenseClaimLifecycle(AWAITING, {
      itemIds: ['a', 'b'],
      rows: [row('a', paid), row('b', { status: 'forwarded', xero_bill_id: 'c', xero_bill_status: 'AUTHORISED' })],
    })
    expect(half.label).toBe('Sent to Xero')
    expect(half.detail).toBe('1 of 2 sent to Xero, 1 of 2 paid')
  })

  it('an item missing its queue row holds the claim at not yet queued', () => {
    const l = expenseClaimLifecycle(AWAITING, { itemIds: ['a', 'b'], rows: [row('a', { status: 'forwarded' })] })
    expect(l.key).toBe('approved_not_queued')
    expect(l.detail).toBe('1 of 2 not yet queued, 1 of 2 sent to Xero')
  })

  it('ignores queue rows for items not on this claim', () => {
    const l = expenseClaimLifecycle(AWAITING, { itemIds: ['a'], rows: [row('a', { status: 'forwarded' }), row('zzz', { status: 'rejected' })] })
    expect(l.key).toBe('sent_to_xero')
  })
})
