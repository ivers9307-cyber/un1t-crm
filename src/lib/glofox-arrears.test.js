import { describe, it, expect } from 'vitest'
import { computeArrears } from './glofox-arrears'

// Build a StripeCharge envelope row matching the live Glofox /Analytics/report
// (TransactionsList) shape. Failed charges carry amount:0 + failed_amount=<owed>;
// paid charges carry amount=<paid>. Values are in EUROS.
function mkStripe({
  invoice_id,
  paid,
  status,
  amount = 0,
  failed_amount,
  event = 'subscription_payment_failed',
  user_id = 'u',
  user_name = 'Member',
  created = '2026-06-01 00:00:00',
  is_forgiven,
  already_paid,
  payment_method = 'credit_card',
}) {
  const metadata = { glofox_event: event, user_id, user_name, payment_method }
  if (is_forgiven !== undefined) metadata.is_forgiven = is_forgiven
  if (already_paid !== undefined) metadata.already_paid = already_paid
  const inner = { invoice_id, paid, status, amount, currency: 'eur', created, metadata, description: event }
  if (failed_amount !== undefined) inner.failed_amount = failed_amount
  return { StripeCharge: inner }
}

describe('computeArrears', () => {
  it('nets out a failed-then-paid invoice (same invoice_id) — not a candidate', () => {
    const rows = [
      mkStripe({ invoice_id: 'D', paid: false, status: 'failed', failed_amount: 209, created: '2026-06-13 19:03:38' }),
      mkStripe({ invoice_id: 'D', paid: true, status: 'paid', amount: 209, event: 'subscription_payment', created: '2026-06-14 17:08:50' }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(0)
    expect(out.totals.paidInvoices).toBe(1)
    expect(out.totals.unpaidInvoices).toBe(0)
  })

  it('flags a failed-twice-never-paid invoice, valued from failed_amount (euros→cents)', () => {
    const rows = [
      mkStripe({ invoice_id: 'R', paid: false, status: 'failed', failed_amount: 179, user_id: 'u_r', user_name: 'Rachael', created: '2026-06-13 23:55:56' }),
      mkStripe({ invoice_id: 'R', paid: false, status: 'failed', failed_amount: 179, user_id: 'u_r', user_name: 'Rachael', created: '2026-06-14 17:08:40' }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(1)
    const c = out.candidates[0]
    expect(c.invoiceId).toBe('R')
    expect(c.amountCents).toBe(17900)
    expect(c.status).toBe('PAST_DUE')
    expect(c.attempts).toBe(2)
    expect(c.glofoxUserId).toBe('u_r')
    expect(out.candidateArrearsCents).toBe(17900)
    expect(out.byMember).toHaveLength(1)
    expect(out.byMember[0].amountCents).toBe(17900)
  })

  it('skips an unpaid invoice that is already present in glofox_invoices', () => {
    const rows = [
      mkStripe({ invoice_id: 'R', paid: false, status: 'failed', failed_amount: 179 }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set(['R']) })
    expect(out.totals.candidates).toBe(0)
    expect(out.totals.skippedAlreadyPresent).toBe(1)
  })

  it('never flags a paid invoice', () => {
    const rows = [mkStripe({ invoice_id: 'P', paid: true, status: 'paid', amount: 99, event: 'invoice_payment' })]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(0)
    expect(out.totals.paidInvoices).toBe(1)
  })

  it('treats metadata.already_paid as settled even with no paid txn in window', () => {
    const rows = [
      mkStripe({ invoice_id: 'A', paid: false, status: 'failed', failed_amount: 209, already_paid: true }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(0)
    expect(out.totals.paidInvoices).toBe(1)
  })

  it('excludes forgiven invoices', () => {
    const rows = [
      mkStripe({ invoice_id: 'F', paid: false, status: 'failed', failed_amount: 99, is_forgiven: true }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(0)
    expect(out.totals.forgivenInvoices).toBe(1)
  })

  it('honours beforeDate — recent unpaid is excluded, older unpaid kept', () => {
    const rows = [
      mkStripe({ invoice_id: 'RECENT', paid: false, status: 'failed', failed_amount: 179, created: '2026-06-13 23:55:56' }),
      mkStripe({ invoice_id: 'OLD', paid: false, status: 'failed', failed_amount: 209, user_id: 'u_o', created: '2026-02-15 10:00:00' }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set(), beforeDate: '2026-05-12' })
    expect(out.totals.candidates).toBe(1)
    expect(out.candidates[0].invoiceId).toBe('OLD')
    expect(out.totals.skippedByDate).toBe(1)
  })

  it('warns (does not flag) an unpaid invoice with no recoverable amount', () => {
    const rows = [mkStripe({ invoice_id: 'Z', paid: false, status: 'failed', amount: 0 })] // no failed_amount
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(0)
    expect(out.totals.skippedNoAmount).toBe(1)
    expect(out.warnings.length).toBeGreaterThan(0)
  })
})
