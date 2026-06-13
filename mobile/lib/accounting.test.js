import { describe, it, expect } from 'vitest'
import { accountingLanding, ACCOUNTING_ROUTES } from './accounting'

describe('accountingLanding', () => {
  it('shows the chooser when the user has two or more surfaces', () => {
    expect(accountingLanding({ canExpenses: true, canInvoices: true, canInbox: true })).toBe('chooser')
    expect(accountingLanding({ canExpenses: true, canInvoices: true, canInbox: false })).toBe('chooser')
    // owner without own-invoices: Expenses + Invoice inbox (Richard's view)
    expect(accountingLanding({ canExpenses: true, canInvoices: false, canInbox: true })).toBe('chooser')
    // SPEND.P3 — card receipts alongside another surface → chooser
    expect(accountingLanding({ canExpenses: true, canCardReceipts: true })).toBe('chooser')
    expect(accountingLanding({ canInbox: true, canCardReceipts: true })).toBe('chooser')
    // all four
    expect(accountingLanding({ canExpenses: true, canInvoices: true, canInbox: true, canCardReceipts: true })).toBe('chooser')
  })

  it('goes straight to the single surface a user has', () => {
    expect(accountingLanding({ canExpenses: true, canInvoices: false, canInbox: false })).toBe('expenses')
    expect(accountingLanding({ canExpenses: false, canInvoices: true, canInbox: false })).toBe('invoices')
    expect(accountingLanding({ canExpenses: false, canInvoices: false, canInbox: true })).toBe('inbox')
    // SPEND.P3 — a card-holder with no other surface lands straight on card receipts
    expect(accountingLanding({ canCardReceipts: true })).toBe('card_receipts')
    // EVENTS-HUB.2 — orders moved under Accounting (revenue is money)
    expect(accountingLanding({ canOrders: true })).toBe('orders')
    expect(accountingLanding({ canInbox: true, canOrders: true })).toBe('chooser')
  })

  it('returns null when the user has no accounting surface', () => {
    expect(accountingLanding({ canExpenses: false, canInvoices: false, canInbox: false })).toBe(null)
    expect(accountingLanding({ canExpenses: false, canInvoices: false, canInbox: false, canCardReceipts: false })).toBe(null)
    expect(accountingLanding({})).toBe(null)
    expect(accountingLanding()).toBe(null)
  })

  it('maps every landing key to a route', () => {
    for (const key of ['expenses', 'invoices', 'inbox', 'card_receipts', 'orders', 'chooser']) {
      expect(typeof ACCOUNTING_ROUTES[key]).toBe('string')
    }
    expect(ACCOUNTING_ROUTES.chooser).toBe('/accounting')
    expect(ACCOUNTING_ROUTES.card_receipts).toBe('/card-receipts')
    expect(ACCOUNTING_ROUTES.orders).toBe('/orders')
  })
})
