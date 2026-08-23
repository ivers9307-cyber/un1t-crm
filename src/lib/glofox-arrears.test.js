import { describe, it, expect } from 'vitest'
import { computeArrears, isMembershipInvoice, MEMBERSHIP_LINE_SUBTYPES, MEMBERSHIP_REPORT_EVENTS } from './glofox-arrears'

// Build a StripeCharge envelope row matching the live Glofox /Analytics/report
// (TransactionsList) shape. Failed charges carry amount:0 + failed_amount=<owed>;
// paid charges carry amount=<paid>. Values are in EUROS.
function mkStripe({
  invoice_id,
  paid,
  status,
  transaction_status,
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
  if (transaction_status !== undefined) inner.transaction_status = transaction_status
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

  it('AWAITING-AUTH.2 — an in-progress (PENDING) charge is a PENDING candidate, not a PAST_DUE debt', () => {
    // A PAYG class booking whose card auth is pending (Cian Gormley's case):
    // Glofox shows "Awaiting authorization". The old blanket 'PAST_DUE' wrongly
    // marked it as debt; it should backfill as PENDING.
    const rows = [
      mkStripe({ invoice_id: 'AW', paid: false, status: 'PENDING', amount: 25, event: 'book_class', user_id: 'u_cian', user_name: 'Cian' }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(1)
    const c = out.candidates[0]
    expect(c.status).toBe('PENDING')
    expect(c.amountCents).toBe(2500)
    expect(c.glofoxEvent).toBe('book_class')
  })

  it('ARREARS-TYPE.2 — Glofox "Awaiting authorization" is transaction_status PENDING_INTENT / status "pending authorization" → a PENDING candidate', () => {
    // The €467 "Client confirmation required: Custom Charge" case (verified live
    // 2026-08-23 via the report probe): paid:false, amount carried on `amount`,
    // NOT the spec's PENDING. The June backfill wrote it as PAST_DUE and it sat
    // on the Overdue chase-list for two months.
    const rows = [
      mkStripe({ invoice_id: 'AI', paid: false, status: 'pending authorization', transaction_status: 'PENDING_INTENT', amount: 467, event: 'custom_charge' }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(1)
    expect(out.candidates[0]).toMatchObject({ invoiceId: 'AI', status: 'PENDING', amountCents: 46700, glofoxEvent: 'custom_charge' })
  })

  it('ARREARS-TYPE.2 — a PENDING_INTENT attempt alongside a failed one is still PAST_DUE (dunning reuses the invoice id)', () => {
    const rows = [
      mkStripe({ invoice_id: 'PI', paid: false, status: 'failed', failed_amount: 209 }),
      mkStripe({ invoice_id: 'PI', paid: false, status: 'pending authorization', transaction_status: 'PENDING_INTENT', amount: 209 }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.candidates).toHaveLength(1)
    expect(out.candidates[0].status).toBe('PAST_DUE')
  })

  it('a genuinely failed charge stays a PAST_DUE candidate', () => {
    const rows = [
      mkStripe({ invoice_id: 'FL', paid: false, status: 'failed', failed_amount: 50, event: 'book_class' }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.candidates[0].status).toBe('PAST_DUE')
  })

  it('a pending-then-failed invoice (one id, subscription dunning) is PAST_DUE, not awaiting-auth (AWAITING-AUTH.2)', () => {
    const rows = [
      mkStripe({ invoice_id: 'PF', paid: false, status: 'PENDING', amount: 209, event: 'subscription_payment_failed' }),
      mkStripe({ invoice_id: 'PF', paid: false, status: 'failed', failed_amount: 209, event: 'subscription_payment_failed' }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.candidates).toHaveLength(1)
    expect(out.candidates[0].status).toBe('PAST_DUE')
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

  // ── ARREARS-NETTING.1 — cross-invoice-id retry netting ──────────────
  // Glofox cuts a NEW invoice_id per payment ATTEMPT for one-off purchases
  // (class packs, single-class fees, signup upfront fees). A failed attempt
  // orphans as its own PAST_DUE invoice_id; the eventual success is a
  // separate PAID invoice_id. Glofox's profile nets the purchase to €0, so
  // a same-member same-amount PAID within ±7 days settles the failed attempt.

  it('nets a failed invoice against a same-member same-amount PAID 2 min later under a DIFFERENT invoice_id (excluded)', () => {
    const rows = [
      // Fran Martin's real case: 2× €25 PAST_DUE then 1× €25 PAID, three invoice_ids.
      mkStripe({ invoice_id: 'fail-1', paid: false, status: 'failed', failed_amount: 25, user_id: 'fran', created: '2026-05-27 10:36:00' }),
      mkStripe({ invoice_id: 'paid-1', paid: true, status: 'paid', amount: 25, user_id: 'fran', event: 'invoice_payment', created: '2026-05-27 10:38:00' }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(0)
    expect(out.totals.skippedSettledRetry).toBe(1)
  })

  it('does NOT net when the only same-amount PAID is 10 days away (window respected — still a candidate)', () => {
    const rows = [
      mkStripe({ invoice_id: 'fail-far', paid: false, status: 'failed', failed_amount: 25, user_id: 'farah', created: '2026-05-01 10:00:00' }),
      mkStripe({ invoice_id: 'paid-far', paid: true, status: 'paid', amount: 25, user_id: 'farah', event: 'invoice_payment', created: '2026-05-11 10:00:00' }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(1)
    expect(out.candidates[0].invoiceId).toBe('fail-far')
    expect(out.totals.skippedSettledRetry).toBe(0)
  })

  it('does NOT net when the in-window PAID is a different amount (candidate unaffected)', () => {
    const rows = [
      mkStripe({ invoice_id: 'fail-amt', paid: false, status: 'failed', failed_amount: 25, user_id: 'gus', created: '2026-05-27 10:36:00' }),
      // Same member, same window, but €40 — an unrelated purchase, not a retry of the €25.
      mkStripe({ invoice_id: 'paid-amt', paid: true, status: 'paid', amount: 40, user_id: 'gus', event: 'invoice_payment', created: '2026-05-27 10:38:00' }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(1)
    expect(out.candidates[0].invoiceId).toBe('fail-amt')
    expect(out.totals.skippedSettledRetry).toBe(0)
  })

  it('a PAID retry settles only ONE of two identical failed invoices (one-to-one consumption)', () => {
    // Two distinct €25 failed purchases for the same member in-window, but only
    // ONE matching PAID — only one is a settled retry, the other still owes.
    const rows = [
      mkStripe({ invoice_id: 'fail-a', paid: false, status: 'failed', failed_amount: 25, user_id: 'hana', created: '2026-05-27 10:36:00' }),
      mkStripe({ invoice_id: 'fail-b', paid: false, status: 'failed', failed_amount: 25, user_id: 'hana', created: '2026-05-27 11:00:00' }),
      mkStripe({ invoice_id: 'paid-a', paid: true, status: 'paid', amount: 25, user_id: 'hana', event: 'invoice_payment', created: '2026-05-27 10:38:00' }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(1)
    expect(out.totals.skippedSettledRetry).toBe(1)
  })

  it('does NOT net across different members even with same amount in-window', () => {
    const rows = [
      mkStripe({ invoice_id: 'fail-iris', paid: false, status: 'failed', failed_amount: 25, user_id: 'iris', created: '2026-05-27 10:36:00' }),
      mkStripe({ invoice_id: 'paid-jack', paid: true, status: 'paid', amount: 25, user_id: 'jack', event: 'invoice_payment', created: '2026-05-27 10:38:00' }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(1)
    expect(out.candidates[0].invoiceId).toBe('fail-iris')
    expect(out.totals.skippedSettledRetry).toBe(0)
  })
})

// ── ARREARS-TYPE.1 — membership payment vs every other charge ──────────────
// Richard's rule (2026-08-23): the Overdue tab is for FAILED MEMBERSHIP
// PAYMENTS only; every other failing transaction is an "unpaid charge",
// whatever its amount. Verified live how Glofox labels each kind:
//   MEMBERSHIPS/SUBSCRIPTION_RENEWAL      recurring renewal           → membership
//   MEMBERSHIPS/SUBSCRIPTION_PAYMENT      first payment at signup     → membership
//     (paired with a €0 MEMBERSHIPS/UPFRONT_PAYMENT line on the same invoice)
//   MEMBERSHIPS/UPFRONT_PAYMENT alone     class packs, credits, trial → NOT
//   CUSTOM_CHARGES/CUSTOM_CHARGE          fees, staff custom charges  → NOT
//   CLASSES/BOOK_CLASS, PRODUCTS/BUY_PRODUCT, WALLET_TOP_UP            → NOT
// Backfilled rows (June 2026) have no line items; they carry the report's
// metadata.glofox_event instead (subscription_payment[_failed] = membership).
describe('isMembershipInvoice (ARREARS-TYPE.1)', () => {
  it('a subscription renewal / first payment / prorate / NSF line is a membership payment', () => {
    expect(isMembershipInvoice({ line_item_subtypes: 'SUBSCRIPTION_RENEWAL' })).toBe(true)
    expect(isMembershipInvoice({ line_item_subtypes: 'SUBSCRIPTION_PAYMENT,UPFRONT_PAYMENT' })).toBe(true)
    expect(isMembershipInvoice({ line_item_subtypes: 'PRORATE' })).toBe(true)
    expect(isMembershipInvoice({ line_item_subtypes: 'NON_SUFFICIENT_FUNDS' })).toBe(true)
    expect(isMembershipInvoice({ line_item_subtypes: 'subscription_renewal' })).toBe(true) // case-insensitive
    expect(MEMBERSHIP_LINE_SUBTYPES).toEqual(['SUBSCRIPTION_RENEWAL', 'SUBSCRIPTION_PAYMENT', 'PRORATE', 'NON_SUFFICIENT_FUNDS'])
  })

  it('a lone UPFRONT_PAYMENT (class pack / credits / trial), a fee, a booking, a product or a top-up is NOT', () => {
    expect(isMembershipInvoice({ line_item_subtypes: 'UPFRONT_PAYMENT' })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: 'CUSTOM_CHARGE' })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: 'BOOK_CLASS' })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: 'BUY_PRODUCT' })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: 'WALLET_TOP_UP' })).toBe(false)
  })

  it('matches whole tokens only — a sub_type that merely CONTAINS a membership token does not count', () => {
    expect(isMembershipInvoice({ line_item_subtypes: 'NOT_A_SUBSCRIPTION_RENEWAL_X' })).toBe(false)
  })

  it('falls back to the report event for backfilled rows (no line items)', () => {
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: 'subscription_payment_failed' })).toBe(true)
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: 'subscription_payment' })).toBe(true)
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: 'custom_charge' })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: 'book_class' })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: 'buy_product' })).toBe(false)
    // A signup invoice and a free trial both arrive as invoice_payment; the
    // backfill kept nothing that tells them apart, so neither is a membership.
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: 'invoice_payment' })).toBe(false)
    expect(MEMBERSHIP_REPORT_EVENTS).toEqual(['subscription_payment', 'subscription_payment_failed'])
  })

  it('no signal at all → not a membership payment', () => {
    expect(isMembershipInvoice({})).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: null })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: '', glofox_event: '' })).toBe(false)
    expect(isMembershipInvoice(null)).toBe(false)
    expect(isMembershipInvoice(undefined)).toBe(false)
  })
})
