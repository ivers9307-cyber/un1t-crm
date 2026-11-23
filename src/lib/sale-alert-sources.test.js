import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./sale-alert', () => ({ notifyNewSale: vi.fn() }))

import { notifyNewSale } from './sale-alert'
import { alertTrialSale, alertClassBookingSale, alertPayLinkSale, alertRaceSale } from './sale-alert-sources'

const db = {}

beforeEach(() => {
  vi.clearAllMocks()
  notifyNewSale.mockResolvedValue({ sent: true })
})

describe('alertTrialSale', () => {
  const trial = { id: 't1', location_id: 'loc-1', contact_id: 'c1', product_name: '€39 Trial', amount_cents: 3900, first_name: 'Ava', customer_name: 'Ava Byrne', payment_provider: 'revolut' }

  it('keys a Revolut trial on the row id', async () => {
    await alertTrialSale(db, trial)
    expect(notifyNewSale).toHaveBeenCalledWith(db, {
      source: 'trial', saleId: 't1', locationId: 'loc-1', itemName: '€39 Trial',
      amountCents: 3900, buyerFirstName: 'Ava', contactId: 'c1',
    })
  })

  it('takes the amount the provider reported over the row\'s own', async () => {
    await alertTrialSale(db, trial, { paidAmountCents: 3500 })
    expect(notifyNewSale).toHaveBeenCalledWith(db, expect.objectContaining({ amountCents: 3500 }))
  })

  it('falls back to the first word of customer_name', async () => {
    await alertTrialSale(db, { ...trial, first_name: null })
    expect(notifyNewSale).toHaveBeenCalledWith(db, expect.objectContaining({ buyerFirstName: 'Ava' }))
  })

  it('keys a un1t.online trial on its transaction id', async () => {
    await alertTrialSale(db, { ...trial, payment_provider: 'un1t_online', payment_provider_ref: '5521' })
    expect(notifyNewSale).toHaveBeenCalledWith(db, expect.objectContaining({ source: 'un1t', saleId: '5521' }))
  })

  it('does not ring a un1t.online trial with no transaction id', async () => {
    const res = await alertTrialSale(db, { ...trial, payment_provider: 'un1t_online', payment_provider_ref: null })
    expect(notifyNewSale).not.toHaveBeenCalled()
    expect(res.sent).toBe(false)
  })

  it('swallows a rejection', async () => {
    notifyNewSale.mockRejectedValue(new Error('boom'))
    await expect(alertTrialSale(db, trial)).resolves.toEqual({ sent: false, reason: 'error' })
  })
})

describe('alertClassBookingSale', () => {
  const booking = { id: 'b1', location_id: 'loc-1', contact_id: 'c2', class_name: 'Hatch Strength', amount_cents: 1500, customer_name: 'Sam Doyle' }

  it('keys a booking on the row id', async () => {
    await alertClassBookingSale(db, booking)
    expect(notifyNewSale).toHaveBeenCalledWith(db, {
      source: 'class_booking', saleId: 'b1', locationId: 'loc-1', itemName: 'Hatch Strength',
      amountCents: 1500, buyerFirstName: 'Sam', contactId: 'c2',
    })
  })

  it('passes a €0 booking through so the zero check refuses it', async () => {
    await alertClassBookingSale(db, { ...booking, amount_cents: 0 })
    expect(notifyNewSale).toHaveBeenCalledWith(db, expect.objectContaining({ amountCents: 0 }))
  })

  it('never rings on an unknown amount', async () => {
    const res = await alertClassBookingSale(db, { ...booking, amount_cents: null })
    expect(notifyNewSale).not.toHaveBeenCalled()
    expect(res).toEqual({ sent: false, reason: 'unknown_amount' })
  })

  it('takes the provider amount when the row has none', async () => {
    await alertClassBookingSale(db, { ...booking, amount_cents: null }, { paidAmountCents: 1500 })
    expect(notifyNewSale).toHaveBeenCalledWith(db, expect.objectContaining({ amountCents: 1500 }))
  })

  it('swallows a rejection', async () => {
    notifyNewSale.mockRejectedValue(new Error('boom'))
    await expect(alertClassBookingSale(db, booking)).resolves.toEqual({ sent: false, reason: 'error' })
  })
})

describe('alertPayLinkSale', () => {
  const link = { id: 'l1', location_id: 'loc-1', contact_id: 'c3', product_title: '1 Month', paid_transaction_id: '777', price_cents: 9900, first_name: 'Kim' }

  it('keys a link on the un1t.online transaction id', async () => {
    await alertPayLinkSale(db, link)
    expect(notifyNewSale).toHaveBeenCalledWith(db, {
      source: 'un1t', saleId: '777', locationId: 'loc-1', itemName: '1 Month',
      amountCents: 9900, buyerFirstName: 'Kim', contactId: 'c3',
    })
  })

  it('prefers the paid amount over the list price', async () => {
    await alertPayLinkSale(db, link, { paidAmountCents: 8900 })
    expect(notifyNewSale).toHaveBeenCalledWith(db, expect.objectContaining({ amountCents: 8900 }))
  })

  it('does not ring without a transaction id', async () => {
    await alertPayLinkSale(db, { ...link, paid_transaction_id: null })
    expect(notifyNewSale).not.toHaveBeenCalled()
  })

  it('swallows a rejection', async () => {
    notifyNewSale.mockRejectedValue(new Error('boom'))
    await expect(alertPayLinkSale(db, link)).resolves.toEqual({ sent: false, reason: 'error' })
  })
})

describe('alertRaceSale', () => {
  const payment = { id: 'rp1', kind: 'entry', amount_cents: 6000, payment_provider: 'revolut', connected_account_id: null, contact_id: 'c9', contact_name: 'Ciara Walsh' }
  const event = { name: 'Summer Hyrox', location_id: 'loc-1' }

  it('rings for a studio-settled entry, keyed on the payment', async () => {
    await alertRaceSale(db, payment, event)
    expect(notifyNewSale).toHaveBeenCalledWith(db, {
      source: 'race', saleId: 'rp1', locationId: 'loc-1', itemName: 'Summer Hyrox',
      amountCents: 6000, buyerFirstName: 'Ciara', contactId: 'c9',
    })
  })

  it('does not ring for an entry paid to a host connected account', async () => {
    await alertRaceSale(db, { ...payment, connected_account_id: 'acct_123' })
    await alertRaceSale(db, { ...payment, payment_provider: 'stripe_connect' }, event)
    expect(notifyNewSale).not.toHaveBeenCalled()
  })

  it('does not ring for a move_gap payment', async () => {
    await alertRaceSale(db, { ...payment, kind: 'move_gap' }, event)
    expect(notifyNewSale).not.toHaveBeenCalled()
  })

  it('does not ring for an event with no location', async () => {
    await alertRaceSale(db, payment, { ...event, location_id: null })
    await alertRaceSale(db, payment, null)
    expect(notifyNewSale).not.toHaveBeenCalled()
  })

  it('does not ring on an unknown or non-positive amount', async () => {
    await alertRaceSale(db, { ...payment, amount_cents: null }, event)
    await alertRaceSale(db, { ...payment, amount_cents: 0 }, event)
    expect(notifyNewSale).not.toHaveBeenCalled()
  })

  it('swallows a rejection', async () => {
    notifyNewSale.mockRejectedValue(new Error('boom'))
    await expect(alertRaceSale(db, payment, event)).resolves.toEqual({ sent: false, reason: 'error' })
  })
})
