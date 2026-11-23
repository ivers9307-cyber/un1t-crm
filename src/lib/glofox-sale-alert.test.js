// SALEALERT.1 — which Glofox INVOICE_UPDATED deliveries are a new sale.
// Fixtures follow the shapes read from production on 23 Nov 2026 (invented
// names, no customer data). Renewals, fees and CRM complimentary grants never ring.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./sale-alert', () => ({ notifyNewSale: vi.fn() }))
vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { notifyNewSale } from './sale-alert'
import { logError } from './log'
import { parseInvoicePayload } from './glofox-invoices'
import { glofoxInvoiceIsNewSale, glofoxInvoiceItemName, alertGlofoxInvoiceSale } from './glofox-sale-alert'

const item = (sub_type, name, unit_price = 5000, type = 'MEMBERSHIPS') => ({ name, type, quantity: 1, sub_type, unit_price, gross_amount: unit_price, applied_taxes: [], applied_discounts: [] })

const invoice = (over = {}) => ({
  Type: 'INVOICE_UPDATED',
  Metadata: { location_id: 'branch-1' },
  Payload: {
    id: 'inv-1', status: 'PAID', total: 5000, currency: 'EUR', payment_method: 'CARD',
    user: { id: 'member-1', email: 'sam@example.test', first_name: 'Sam', last_name: 'Sample' },
    line_items: [item('UPFRONT_PAYMENT', 'Sample Class Pack', 5000, 'PROGRAMS')],
    ...over,
  },
})

const ringsFor = (over) => glofoxInvoiceIsNewSale(parseInvoicePayload(invoice(over)))

describe('glofoxInvoiceIsNewSale', () => {
  it('a paid class pack (UPFRONT_PAYMENT, card) rings', () => {
    expect(ringsFor({})).toMatchObject({ ring: true })
  })
  it('a new membership first payment (SUBSCRIPTION_PAYMENT + UPFRONT_PAYMENT, card or bank transfer) rings', () => {
    const line_items = [item('SUBSCRIPTION_PAYMENT', 'Sample Membership'), item('UPFRONT_PAYMENT', 'Sample Membership', 0)]
    expect(ringsFor({ line_items }).ring).toBe(true)
    expect(ringsFor({ line_items, payment_method: 'BANK_TRANSFER' }).ring).toBe(true)
  })
  it('a paid drop-in class (BOOK_CLASS) rings', () => {
    expect(ringsFor({ line_items: [item('BOOK_CLASS', 'Sample Class', 1500, 'CLASSES')], total: 1500 }).ring).toBe(true)
  })
  it('a renewal never rings', () => {
    expect(ringsFor({ line_items: [item('SUBSCRIPTION_RENEWAL', 'Subscription Renewal')] })).toMatchObject({ ring: false })
  })
  it('a late-cancel / no-show fee (CUSTOM_CHARGE) never rings', () => {
    expect(ringsFor({ line_items: [item('CUSTOM_CHARGE', 'Extra Late Cancel Fee, Sample Class, 1 Nov', 1000, 'CUSTOM')], total: 1000 }).ring).toBe(false)
  })
  it('PRORATE and NON_SUFFICIENT_FUNDS never ring', () => {
    expect(ringsFor({ line_items: [item('PRORATE', 'x')] }).ring).toBe(false)
    expect(ringsFor({ line_items: [item('NON_SUFFICIENT_FUNDS', 'x')] }).ring).toBe(false)
  })
  it('one unknown sub-type among allowed ones blocks the ring', () => {
    expect(ringsFor({ line_items: [item('UPFRONT_PAYMENT', 'a'), item('SOMETHING_NEW', 'b')] }).ring).toBe(false)
  })
  it('an invoice with no sub-types does not ring', () => {
    expect(ringsFor({ line_items: [] }).ring).toBe(false)
  })
  it('a complimentary receipt (CRM grant, any case) never rings, even with an amount', () => {
    expect(ringsFor({ payment_method: 'COMPLIMENTARY', total: 0 }).ring).toBe(false)
    expect(ringsFor({ payment_method: 'complimentary', total: 3900 }).ring).toBe(false)
  })
  it('a €0 invoice never rings', () => {
    expect(ringsFor({ total: 0 }).ring).toBe(false)
  })
  it('anything not PAID never rings', () => {
    for (const status of ['PENDING', 'PAST_DUE', 'CANCELLED', 'FORGIVEN', 'UNKNOWN']) {
      expect(ringsFor({ status }).ring).toBe(false)
    }
  })
  it('gives a reason for every refusal', () => {
    expect(ringsFor({ status: 'PENDING' }).reason).toEqual(expect.any(String))
  })
})

describe('glofoxInvoiceItemName', () => {
  it('prefers the first named line item with a price above zero', () => {
    const p = invoice({ line_items: [item('UPFRONT_PAYMENT', 'Free Part', 0), item('SUBSCRIPTION_PAYMENT', 'Paid Part', 4900)] })
    expect(glofoxInvoiceItemName(p)).toBe('Paid Part')
  })
  it('falls back to the first named item, then to a generic label', () => {
    expect(glofoxInvoiceItemName(invoice({ line_items: [item('UPFRONT_PAYMENT', 'Only Part', 0)] }))).toBe('Only Part')
    expect(glofoxInvoiceItemName(invoice({ line_items: [item('UPFRONT_PAYMENT', '  ', 100)] }))).toBe('Glofox purchase')
    expect(glofoxInvoiceItemName({})).toBe('Glofox purchase')
  })
  it('reads an unwrapped payload as well as the wrapped event', () => {
    expect(glofoxInvoiceItemName(invoice().Payload)).toBe('Sample Class Pack')
  })
})

describe('alertGlofoxInvoiceSale', () => {
  const db = { from: vi.fn() }
  beforeEach(() => {
    vi.clearAllMocks()
    notifyNewSale.mockResolvedValue({ sent: true })
  })

  it('rings once with the invoice id as the key, the delivery amount, item and buyer first name', async () => {
    await alertGlofoxInvoiceSale(db, { locationId: 'loc-1', payload: invoice(), contact: { id: 'c-1' } })
    expect(notifyNewSale).toHaveBeenCalledTimes(1)
    expect(notifyNewSale).toHaveBeenCalledWith(db, {
      source: 'glofox', saleId: 'inv-1', locationId: 'loc-1',
      itemName: 'Sample Class Pack', amountCents: 5000, buyerFirstName: 'Sam', contactId: 'c-1',
    })
  })

  it('an unmatched member still rings, with no contactId', async () => {
    await alertGlofoxInvoiceSale(db, { locationId: 'loc-1', payload: invoice(), contact: null })
    const args = notifyNewSale.mock.calls[0][1]
    expect(args.contactId).toBeUndefined()
    expect(args.saleId).toBe('inv-1')
  })

  it('omits the buyer name when the payload carries none', async () => {
    await alertGlofoxInvoiceSale(db, { locationId: 'loc-1', payload: invoice({ user: { id: 'member-1' } }), contact: null })
    expect(notifyNewSale.mock.calls[0][1].buyerFirstName).toBeUndefined()
  })

  it('falls back to the first word of a single name field', async () => {
    await alertGlofoxInvoiceSale(db, { locationId: 'loc-1', payload: invoice({ user: { id: 'm', name: 'Sam Sample' } }), contact: null })
    expect(notifyNewSale.mock.calls[0][1].buyerFirstName).toBe('Sam')
  })

  it('does not ring for a renewal, a fee, a complimentary receipt or an unpaid invoice', async () => {
    for (const over of [
      { line_items: [item('SUBSCRIPTION_RENEWAL', 'Subscription Renewal')] },
      { line_items: [item('CUSTOM_CHARGE', 'Fee', 1000)] },
      { payment_method: 'COMPLIMENTARY', total: 0 },
      { status: 'PAST_DUE' },
    ]) {
      expect(await alertGlofoxInvoiceSale(db, { locationId: 'loc-1', payload: invoice(over), contact: { id: 'c' } })).toMatchObject({ sent: false })
    }
    expect(notifyNewSale).not.toHaveBeenCalled()
  })

  it('does not ring without a location or an invoice id', async () => {
    await alertGlofoxInvoiceSale(db, { locationId: null, payload: invoice(), contact: null })
    await alertGlofoxInvoiceSale(db, { locationId: 'loc-1', payload: invoice({ id: undefined }), contact: null })
    await alertGlofoxInvoiceSale(db, { locationId: 'loc-1', payload: null, contact: null })
    expect(notifyNewSale).not.toHaveBeenCalled()
  })

  it('never throws, and logs without the buyer name when the ring fails', async () => {
    notifyNewSale.mockRejectedValue(new Error('push down'))
    await expect(alertGlofoxInvoiceSale(db, { locationId: 'loc-1', payload: invoice(), contact: null })).resolves.toMatchObject({ sent: false })
    expect(JSON.stringify(logError.mock.calls)).not.toMatch(/Sam|Sample/)
  })
})
