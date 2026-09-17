import { describe, it, expect } from 'vitest'
import {
  rosterComparison,
  rosterComparisonSummary,
  selectReviewComparison,
  contractorInvoiceLifecycle,
  latestQueueRowByInvoice,
} from './contractor-invoice-review.js'

describe('rosterComparison — tolerance', () => {
  it('reads a rate-rounding artefact as a match (€19.98 profile vs €20 invoiced, 80h)', () => {
    // 80h × €19.98 = €1,598.40 rostered; invoiced 80h × €20 = €1,600.
    const cmp = rosterComparison({ invoiced: 1600, estimated: 1598.4 })
    expect(cmp.verdict).toBe('matches')
    expect(cmp.diff).toBe(1.6)
    expect(rosterComparisonSummary(cmp)).toBe('Matches roster')
  })

  it('treats a sub-€1 delta as a match even when the % is large', () => {
    expect(rosterComparison({ invoiced: 10.5, estimated: 10 }).verdict).toBe('matches')
  })

  it('flags a real over-invoice with amount and percent', () => {
    const cmp = rosterComparison({ invoiced: '742.00', estimated: 700 })
    expect(cmp).toMatchObject({ verdict: 'over', diff: 42, pct: 6, significant: true })
    expect(rosterComparisonSummary(cmp)).toBe('€42.00 over roster (+6.0%)')
  })

  it('flags an under-invoice as not significant under 5%', () => {
    const cmp = rosterComparison({ invoiced: 980, estimated: 1000 })
    expect(cmp).toMatchObject({ verdict: 'under', diff: -20, pct: -2, significant: false })
    expect(rosterComparisonSummary(cmp)).toBe('€20.00 under roster (−2.0%)')
  })

  it('is unknown when no estimate exists (rate not set)', () => {
    const cmp = rosterComparison({ invoiced: 500, estimated: null })
    expect(cmp.verdict).toBe('unknown')
    expect(rosterComparisonSummary(cmp)).toMatch(/rate not set/)
  })

  it('a zero estimate with a real invoice is a significant over', () => {
    const cmp = rosterComparison({ invoiced: 300, estimated: 0 })
    expect(cmp).toMatchObject({ verdict: 'over', pct: null, significant: true })
  })
})

const LIVE = { scheduled_hours: 40, shift_count: 10, hourly_rate: 20, estimated_cost: 800 }

describe('selectReviewComparison — snapshot vs live', () => {
  it('before approval shows the live recompute only', () => {
    const r = selectReviewComparison({ status: 'submitted', invoice_amount: 800 }, LIVE)
    expect(r.primary.source).toBe('live')
    expect(r.primary.shift_count).toBe(10)
    expect(r.primary.comparison.verdict).toBe('matches')
    expect(r.current).toBeNull()
    expect(r.snapshot_missing).toBe(false)
  })

  it('after approval shows the SAVED snapshot, labelled with the approval date', () => {
    const inv = {
      status: 'awaiting_accountant_review', invoice_amount: '800.00',
      approved_at: '2026-09-02T10:00:00Z', reviewed_at: '2026-09-02T10:00:00Z',
      scheduled_hours_at_review: '40.00', estimated_cost_at_review: '800.00', hourly_rate_at_review: '20.00',
    }
    const r = selectReviewComparison(inv, LIVE)
    expect(r.primary).toMatchObject({ source: 'snapshot', as_of: '2026-09-02T10:00:00Z', scheduled_hours: 40, estimated_cost: 800 })
    expect(r.current).toBeNull() // identical → no secondary line
  })

  it('surfaces a drifted live roster as a secondary current line, keeping the snapshot primary', () => {
    const inv = {
      status: 'awaiting_accountant_review', invoice_amount: 800, approved_at: '2026-09-02T10:00:00Z',
      scheduled_hours_at_review: 40, estimated_cost_at_review: 800, hourly_rate_at_review: 20,
    }
    const drifted = { ...LIVE, scheduled_hours: 36, estimated_cost: 720 }
    const r = selectReviewComparison(inv, drifted)
    expect(r.primary.source).toBe('snapshot')
    expect(r.primary.comparison.verdict).toBe('matches')
    expect(r.current).toMatchObject({ source: 'live', scheduled_hours: 36, estimated_cost: 720 })
    expect(r.current.comparison.verdict).toBe('over')
  })

  it('keeps the snapshot even when the live recompute is unavailable', () => {
    const inv = { status: 'approved', invoice_amount: 800, approved_at: 'x', scheduled_hours_at_review: 40, estimated_cost_at_review: null, hourly_rate_at_review: null }
    const r = selectReviewComparison(inv, null)
    expect(r.primary.source).toBe('snapshot')
    expect(r.primary.comparison.verdict).toBe('unknown')
  })

  it('an approved row with no snapshot falls back to live and says so', () => {
    const r = selectReviewComparison({ status: 'awaiting_accountant_review', invoice_amount: 800 }, LIVE)
    expect(r.primary.source).toBe('live')
    expect(r.snapshot_missing).toBe(true)
  })

  it('a declined row never uses a snapshot', () => {
    const r = selectReviewComparison({ status: 'declined', invoice_amount: 800, scheduled_hours_at_review: 1 }, LIVE)
    expect(r.primary.source).toBe('live')
  })

  it('null when there is nothing to show', () => {
    expect(selectReviewComparison({ status: 'submitted', invoice_amount: 1 }, null)).toBeNull()
    expect(selectReviewComparison(null, LIVE)).toBeNull()
  })
})

describe('contractorInvoiceLifecycle — honest labels', () => {
  const awaiting = { status: 'awaiting_accountant_review' }

  it('never reads "With accountant"', () => {
    const labels = [
      contractorInvoiceLifecycle(awaiting),
      contractorInvoiceLifecycle(awaiting, null),
      contractorInvoiceLifecycle(awaiting, { status: 'quality_approved' }),
    ].map((l) => l.label)
    for (const l of labels) expect(l).not.toMatch(/with accountant/i)
  })

  it('queued at each pre-forward queue status', () => {
    for (const status of ['quality_approved', 'extracted', 'data_approved']) {
      expect(contractorInvoiceLifecycle(awaiting, { status })).toEqual({
        key: 'queued_for_accountant', label: 'Approved, queued for accountant', tone: 'green',
      })
    }
  })

  it('Sent to Xero once the queue row is forwarded or a bill id exists', () => {
    expect(contractorInvoiceLifecycle(awaiting, { status: 'forwarded' }).label).toBe('Sent to Xero')
    expect(contractorInvoiceLifecycle(awaiting, { status: 'data_approved', xero_bill_id: 'b1' }).label).toBe('Sent to Xero')
    expect(contractorInvoiceLifecycle(awaiting, { status: 'forwarded', xero_bill_status: 'AUTHORISED' }).label).toBe('Sent to Xero')
  })

  it('Paid only on the Xero webhook paid signal', () => {
    expect(contractorInvoiceLifecycle(awaiting, { status: 'forwarded', xero_bill_status: 'PAID' }).key).toBe('paid')
    expect(contractorInvoiceLifecycle(awaiting, { status: 'forwarded', xero_bill_paid_at: '2026-09-10T00:00:00Z' }).key).toBe('paid')
  })

  it('voided and rejected are surfaced, not hidden', () => {
    expect(contractorInvoiceLifecycle(awaiting, { status: 'forwarded', xero_bill_status: 'VOIDED' }).key).toBe('voided_in_xero')
    expect(contractorInvoiceLifecycle(awaiting, { status: 'rejected' }).key).toBe('rejected_by_accountant')
  })

  it('distinguishes "lookup not done" from "no queue row"', () => {
    expect(contractorInvoiceLifecycle(awaiting, undefined).label).toBe('Approved')
    expect(contractorInvoiceLifecycle(awaiting, null).key).toBe('approved_not_queued')
  })

  it('legacy direct-forward rows and the other statuses', () => {
    expect(contractorInvoiceLifecycle({ status: 'approved', xero_synced_at: 't' }).label).toBe('Sent to Xero')
    expect(contractorInvoiceLifecycle({ status: 'approved' }).label).toBe('Approved')
    expect(contractorInvoiceLifecycle({ status: 'submitted' }).label).toBe('Awaiting review')
    expect(contractorInvoiceLifecycle({ status: 'declined' }).tone).toBe('red')
    expect(contractorInvoiceLifecycle({ status: 'revoked' }).label).toBe('Revoked by contractor')
  })
})

describe('latestQueueRowByInvoice', () => {
  it('keeps the newest row per contractor invoice', () => {
    const map = latestQueueRowByInvoice([
      { id: 'q1', source_contractor_invoice_id: 'a', created_at: '2026-09-01T00:00:00Z' },
      { id: 'q2', source_contractor_invoice_id: 'a', created_at: '2026-09-03T00:00:00Z' },
      { id: 'q3', source_contractor_invoice_id: 'b', created_at: '2026-09-02T00:00:00Z' },
      { id: 'x', source_contractor_invoice_id: null },
    ])
    expect(map.get('a').id).toBe('q2')
    expect(map.get('b').id).toBe('q3')
    expect(map.size).toBe(2)
  })
})
