// OFFERTRACK.1 — Meta events for /offers sales.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
import { sendOfferCheckoutConversions, sendOfferPurchaseConversion, offerPurchaseEventId } from './offer-purchase-conversion.js'
import { createFakeDb } from '../../tests/helpers/fake-db.js'

const LOC = '00000000-0000-4000-8000-0000000000aa'
const OFFER = '00000000-0000-4000-8000-0000000000bb'
const PID = '00000000-0000-4000-8000-0000000000cc'
const attribution = { fbc: 'fb.1.1.x', fbp: 'fb.1.2.y', event_source_url: 'https://x.test/offers/a/b', client_ip: '1.2.3.4', client_user_agent: 'UA', utm_campaign: 'c' }
const row = (over = {}) => ({
  id: PID, offer_id: OFFER, location_id: LOC, contact_id: null, buyer_name: 'Jane Ann Doe', buyer_email: 'jane@example.test',
  buyer_phone: '0870000000', amount_cents: 4900, currency: 'EUR', origin: 'page', state: 'paid', attribution, ...over,
})
let send
beforeEach(() => { send = vi.fn(async () => ({ sent: true })) })

describe('sendOfferCheckoutConversions', () => {
  it('sends Lead and InitiateCheckout under the browser\'s ids, with the price and the buyer', async () => {
    await sendOfferCheckoutConversions({}, {
      offer: { location_id: LOC, name: '20 Class Pack', price_cents: 49700, currency: 'EUR' },
      buyer: { name: 'Jane Doe', email: 'jane@example.test', phone: '087' },
      attribution: { ...attribution, lead_event_id: 'lead_1234567' }, purchaseId: PID,
    }, { send })
    expect(send.mock.calls.map(([, a]) => [a.eventName, a.eventId])).toEqual([
      ['Lead', 'lead_1234567'], ['InitiateCheckout', 'offercheckout-lead_1234567'],
    ])
    expect(send.mock.calls[1][1]).toMatchObject({ value: 497, currency: 'EUR', firstName: 'Jane', lastName: 'Doe', clientIp: '1.2.3.4', fbc: 'fb.1.1.x' })
  })

  it('never throws when Meta fails', async () => {
    send.mockRejectedValue(new Error('down'))
    await expect(sendOfferCheckoutConversions({}, { offer: { location_id: LOC }, buyer: {}, attribution: null, purchaseId: PID }, { send })).resolves.toBeUndefined()
  })
})

// The shared fake database, checked against the schema snapshot (which has
// offer_purchases.attribution since the refresh through migration 859).
function fakeDb({ rows = [], readError = null } = {}) {
  return createFakeDb({
    tables: {
      sale_offers: [{ id: OFFER, location_id: LOC, slug: 'pack', category: 'class_pack', name: '20 Class Pack', bonus_headline: 'x', price_cents: 4900 }],
      offer_purchases: rows,
    },
    errors: readError ? { offer_purchases: { select: readError } } : {},
  })
}

describe('sendOfferPurchaseConversion', () => {
  const dbWith = (r) => fakeDb({ rows: [r] })

  it('sends one Purchase for a paid page sale, then removes the buyer\'s browser details', async () => {
    const db = dbWith(row())
    await sendOfferPurchaseConversion(db, PID, { send })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][1]).toMatchObject({
      eventName: 'Purchase', eventId: offerPurchaseEventId(PID), value: 49, orderId: PID, contentName: '20 Class Pack',
      clientIp: '1.2.3.4', userAgent: 'UA', fbc: 'fb.1.1.x',
    })
    const stored = db.tables.offer_purchases[0].attribution
    expect(stored).toEqual({ fbc: 'fb.1.1.x', fbp: 'fb.1.2.y', event_source_url: 'https://x.test/offers/a/b', utm_campaign: 'c' })
  })

  it('a sale made outside the page, or a row not paid, sends nothing', async () => {
    await sendOfferPurchaseConversion(dbWith(row({ origin: 'off_page' })), PID, { send })
    await sendOfferPurchaseConversion(dbWith(row({ state: 'created' })), PID, { send })
    expect(send).not.toHaveBeenCalled()
  })

  it('an unreadable row sends nothing and never throws', async () => {
    const db = fakeDb({ rows: [row()], readError: { message: 'down' } })
    await expect(sendOfferPurchaseConversion(db, PID, { send })).resolves.toMatchObject({ sent: false })
    expect(send).not.toHaveBeenCalled()
  })

  it('still removes the browser details when Meta fails', async () => {
    send.mockRejectedValue(new Error('down'))
    const db = dbWith(row())
    await sendOfferPurchaseConversion(db, PID, { send })
    expect('client_ip' in db.tables.offer_purchases[0].attribution).toBe(false)
  })
})
