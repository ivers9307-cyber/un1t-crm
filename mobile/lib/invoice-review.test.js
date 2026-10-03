import { describe, it, expect } from 'vitest'
import { invoiceStatusBadge, reviewComparisonView, rosterUnreadableNotice } from './invoice-review.js'
import { selectReviewComparison, contractorInvoiceLifecycle } from 'shared/contractor-invoice-review'

describe('invoiceStatusBadge', () => {
  it('renders the server lifecycle label and tone', () => {
    const lifecycle = contractorInvoiceLifecycle({ status: 'awaiting_accountant_review' }, { status: 'forwarded', xero_bill_status: 'PAID' })
    const b = invoiceStatusBadge({ status: 'awaiting_accountant_review', lifecycle })
    expect(b).toMatchObject({ label: 'Paid', icon: 'cash-outline', text: 'text-green-700' })
  })

  it('queued state reads honestly', () => {
    const lifecycle = contractorInvoiceLifecycle({ status: 'awaiting_accountant_review' }, { status: 'quality_approved' })
    expect(invoiceStatusBadge({ status: 'awaiting_accountant_review', lifecycle }).label).toBe('Approved, queued for accountant')
  })

  it('falls back without a lifecycle (older server) and never over-claims', () => {
    expect(invoiceStatusBadge({ status: 'awaiting_accountant_review' }).label).toBe('Approved')
    expect(invoiceStatusBadge({ status: 'submitted' })).toMatchObject({ label: 'Awaiting review', icon: 'time-outline', text: 'text-amber-700' })
    expect(invoiceStatusBadge({ status: 'declined' }).text).toBe('text-red-700')
    expect(invoiceStatusBadge({ status: 'approved', xero_synced_at: 't' }).label).toBe('Sent to Xero')
  })
})

describe('reviewComparisonView', () => {
  const LIVE = { scheduled_hours: 40, shift_count: 10, hourly_rate: 19.98, estimated_cost: 799.2 }

  it('null for a contractor (no review_comparison)', () => {
    expect(reviewComparisonView({ invoice_amount: 800, review_comparison: null })).toBeNull()
    expect(reviewComparisonView(null)).toBeNull()
  })

  it('before approval: live roster, and a €19.98 vs €20 rate reads as a match', () => {
    const inv = { status: 'submitted', invoice_amount: 800 }
    const v = reviewComparisonView({ ...inv, review_comparison: selectReviewComparison(inv, LIVE) })
    expect(v.heading).toBe('Roster vs invoice')
    expect(v.rows.map((r) => r.value)).toEqual(['40 h', '€19.98/h', '€799.20'])
    expect(v.rows[0].sub).toBe('10 shifts')
    expect(v.invoiced).toBe('€800.00')
    expect(v.verdict).toMatchObject({ summary: 'Matches roster', tone: 'green', text: 'text-green-700' })
    expect(v.current).toBeNull()
  })

  it('after approval: snapshot heading with the approval date, drift as a secondary line', () => {
    const inv = {
      status: 'awaiting_accountant_review', invoice_amount: 800, approved_at: '2026-09-02T10:00:00Z',
      scheduled_hours_at_review: 40, estimated_cost_at_review: 800, hourly_rate_at_review: 20,
    }
    const drifted = { scheduled_hours: 30, shift_count: 8, hourly_rate: 20, estimated_cost: 600 }
    const v = reviewComparisonView({ ...inv, review_comparison: selectReviewComparison(inv, drifted) })
    expect(v.heading).toMatch(/^Roster vs invoice, as approved on 2 Sept? 2026$/)
    expect(v.rows[0].sub).toBeNull()
    expect(v.verdict.tone).toBe('green')
    expect(v.current.heading).toMatch(/changed since approval/)
    expect(v.current.summary).toBe('€200.00 over roster (+33.3%)')
  })

  it('flags a significant mismatch red and a small one amber', () => {
    const big = { status: 'submitted', invoice_amount: 900 }
    expect(reviewComparisonView({ ...big, review_comparison: selectReviewComparison(big, { ...LIVE, estimated_cost: 800 }) }).verdict.tone).toBe('red')
    const small = { status: 'submitted', invoice_amount: 830 }
    expect(reviewComparisonView({ ...small, review_comparison: selectReviewComparison(small, { ...LIVE, estimated_cost: 800 }) }).verdict.tone).toBe('amber')
  })

  it('rate not set: warns and verdict is neutral', () => {
    const inv = { status: 'submitted', invoice_amount: 800 }
    const v = reviewComparisonView({ ...inv, review_comparison: selectReviewComparison(inv, { scheduled_hours: 40, shift_count: 10, hourly_rate: null, estimated_cost: null }) })
    expect(v.rows[1]).toMatchObject({ value: 'Not set on profile', warn: true })
    expect(v.verdict.tone).toBe('slate')
  })

  it('legacy approval without a snapshot carries a note', () => {
    const inv = { status: 'awaiting_accountant_review', invoice_amount: 800 }
    const v = reviewComparisonView({ ...inv, review_comparison: selectReviewComparison(inv, LIVE) })
    expect(v.note).toMatch(/before snapshots/)
  })
})

// D4 UINITS.1 (found planning A3) — GET /api/invoices/[id] says
// roster_unavailable when the live roster read failed; with no approval
// snapshot to fall back on there is no comparison, and the phone used to show
// nothing at all. Same rule and words as the web's RosterCheckNotes.
describe('rosterUnreadableNotice', () => {
  it('a submitted invoice with an unreadable roster and no comparison: say so, and to refresh before approving', () => {
    expect(rosterUnreadableNotice({ status: 'submitted', roster_unavailable: true, review_comparison: null }))
      .toBe('Could not read the roster for this period, so there is no schedule comparison. Refresh before approving.')
  })

  it('any other status: the short form (only a submitted invoice can be approved)', () => {
    for (const status of ['awaiting_accountant_review', 'declined', 'revoked']) {
      expect(rosterUnreadableNotice({ status, roster_unavailable: true, review_comparison: null }))
        .toBe("Couldn't read the roster for this period.")
    }
  })

  it('nothing to say when there IS a comparison (an approval snapshot), the read worked, or there is no invoice', () => {
    expect(rosterUnreadableNotice({ status: 'submitted', roster_unavailable: true, review_comparison: { primary: { source: 'snapshot' } } })).toBeNull()
    expect(rosterUnreadableNotice({ status: 'submitted', roster_unavailable: false, review_comparison: null })).toBeNull()
    expect(rosterUnreadableNotice({ status: 'submitted', review_comparison: null })).toBeNull()
    expect(rosterUnreadableNotice(null)).toBeNull()
  })

  it('never an em-dash', () => {
    for (const status of ['submitted', 'declined']) {
      expect(rosterUnreadableNotice({ status, roster_unavailable: true })).not.toMatch(/\u2014/)
    }
  })
})
