import { describe, it, expect } from 'vitest'
import { accountingLanding, ACCOUNTING_ROUTES } from './accounting'

describe('accountingLanding', () => {
  it('shows the chooser when the user has two or three surfaces', () => {
    expect(accountingLanding({ canExpenses: true, canInvoices: true, canInbox: true })).toBe('chooser')
    expect(accountingLanding({ canExpenses: true, canInvoices: true, canInbox: false })).toBe('chooser')
    // owner without own-invoices: Expenses + Invoice inbox (Richard's view)
    expect(accountingLanding({ canExpenses: true, canInvoices: false, canInbox: true })).toBe('chooser')
  })

  it('goes straight to the single surface a user has', () => {
    expect(accountingLanding({ canExpenses: true, canInvoices: false, canInbox: false })).toBe('expenses')
    expect(accountingLanding({ canExpenses: false, canInvoices: true, canInbox: false })).toBe('invoices')
    expect(accountingLanding({ canExpenses: false, canInvoices: false, canInbox: true })).toBe('inbox')
  })

  it('returns null when the user has no accounting surface', () => {
    expect(accountingLanding({ canExpenses: false, canInvoices: false, canInbox: false })).toBe(null)
    expect(accountingLanding({})).toBe(null)
    expect(accountingLanding()).toBe(null)
  })

  it('maps every landing key to a route', () => {
    for (const key of ['expenses', 'invoices', 'inbox', 'chooser']) {
      expect(typeof ACCOUNTING_ROUTES[key]).toBe('string')
    }
    expect(ACCOUNTING_ROUTES.chooser).toBe('/accounting')
  })
})
