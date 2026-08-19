import { describe, it, expect, vi, beforeEach } from 'vitest'

const findOrCreateRaceContact = vi.fn(async () => 'contact-1')
vi.mock('./race-contact-linking', () => ({ findOrCreateRaceContact: (...a) => findOrCreateRaceContact(...a) }))
const writeContactTag = vi.fn(async () => ({ written: true }))
vi.mock('./contact-tags', () => ({ writeContactTag: (...a) => writeContactTag(...a) }))
const sendOpsAlert = vi.fn(async () => ({ channel: 'email' }))
vi.mock('./ops-alerts', () => ({ sendOpsAlert: (...a) => sendOpsAlert(...a) }))

import {
  OFFER_SALE_TAG,
  offerIsOpen,
  offerHasDeadline,
  formatEuro,
  formatSaleDeadline,
  resolveOfferPurchaseByOrderId,
  markOfferPurchaseState,
  linkOrCreateContactForPurchase,
  notifyStaffOfPaidPurchase,
} from './sale-offers'

beforeEach(() => {
  findOrCreateRaceContact.mockClear()
  writeContactTag.mockClear()
  sendOpsAlert.mockClear()
})

const openOffer = {
  active: true,
  starts_at: '2026-08-08T00:00:00Z',
  ends_at: '2026-08-11T22:59:59Z', // 23:59:59 Dublin (UTC+1)
}

describe('offerIsOpen', () => {
  it('true inside the window', () => {
    expect(offerIsOpen(openOffer, new Date('2026-08-09T12:00:00Z'))).toBe(true)
  })
  it('false when inactive', () => {
    expect(offerIsOpen({ ...openOffer, active: false }, new Date('2026-08-09T12:00:00Z'))).toBe(false)
  })
  it('false before starts_at', () => {
    expect(offerIsOpen(openOffer, new Date('2026-08-07T12:00:00Z'))).toBe(false)
  })
  it('false after ends_at (first second past midnight Monday Dublin)', () => {
    expect(offerIsOpen(openOffer, new Date('2026-08-11T23:00:00Z'))).toBe(false)
  })
  it('true at the final second', () => {
    expect(offerIsOpen(openOffer, new Date('2026-08-11T22:59:59Z'))).toBe(true)
  })
})

describe('formatEuro', () => {
  it('whole euros, thousands separator, no cents', () => {
    expect(formatEuro(49700)).toBe('€497')
    expect(formatEuro(104400)).toBe('€1,044')
    expect(formatEuro(206800)).toBe('€2,068')
  })
})

describe('evergreen offers (gift cards, GIFTCARD.1)', () => {
  const evergreen = { active: true, starts_at: '2026-08-01T00:00:00Z', ends_at: null }

  // new Date(null) is the epoch, so an unguarded `now <= ends_at` closes an
  // evergreen offer instantly. This is the regression that guard exists for.
  it('is open indefinitely when ends_at is null', () => {
    expect(offerIsOpen(evergreen, new Date('2026-08-12T10:00:00Z'))).toBe(true)
    expect(offerIsOpen(evergreen, new Date('2035-01-01T00:00:00Z'))).toBe(true)
  })

  it('still respects starts_at and active', () => {
    expect(offerIsOpen(evergreen, new Date('2026-07-01T00:00:00Z'))).toBe(false)
    expect(offerIsOpen({ ...evergreen, active: false }, new Date('2026-09-01T00:00:00Z'))).toBe(false)
  })

  it('offerHasDeadline separates a timed sale from an evergreen product', () => {
    expect(offerHasDeadline(evergreen)).toBe(false)
    expect(offerHasDeadline({ ends_at: '2026-08-10T22:59:59Z' })).toBe(true)
  })
})

describe('formatSaleDeadline', () => {
  it('renders the Dublin wall-clock weekday/date/time, uppercased', () => {
    // 2026-08-10 23:59:59+01 (Dublin summer time) = 22:59:59Z
    expect(formatSaleDeadline('2026-08-10T22:59:59Z')).toBe('MONDAY 10 AUGUST, 23:59')
  })
  it('uses Dublin time, not UTC (an instant just past Dublin midnight is the NEXT day)', () => {
    expect(formatSaleDeadline('2026-08-10T23:30:00Z')).toBe('TUESDAY 11 AUGUST, 00:30')
  })
  it('honours uppercase:false for sentence copy', () => {
    expect(formatSaleDeadline('2026-08-10T22:59:59Z', { uppercase: false })).toBe('Monday 10 August, 23:59')
  })
  it('empty for missing or unparseable input', () => {
    expect(formatSaleDeadline(null)).toBe('')
    expect(formatSaleDeadline('not a date')).toBe('')
  })
})

describe('resolveOfferPurchaseByOrderId', () => {
  it('returns the row joined to its offer, null when absent', async () => {
    const row = { id: 'p1', state: 'created', offer: { id: 'o1', slug: '3-month-membership' } }
    const db = {
      from() { return this }, select() { return this }, eq() { return this },
      maybeSingle: async () => ({ data: row }),
    }
    expect(await resolveOfferPurchaseByOrderId(db, 'ord_1')).toEqual(row)
    db.maybeSingle = async () => ({ data: null })
    expect(await resolveOfferPurchaseByOrderId(db, 'ord_2')).toBeNull()
  })
})

function makeUpdateDb(updates) {
  return {
    from() { return this },
    update(u) { updates.push(u); return this },
    eq() { return this },
  }
}

describe('markOfferPurchaseState', () => {
  it('completed → paid, stamps paid_at', async () => {
    const updates = []
    const r = await markOfferPurchaseState({ db: makeUpdateDb(updates), purchase: { id: 'p1', state: 'created', paid_at: null }, providerState: 'completed' })
    expect(r).toEqual({ changed: true, state: 'paid' })
    expect(updates[0].state).toBe('paid')
    expect(updates[0].paid_at).toBeTruthy()
  })
  it('idempotent: already paid → no update, never downgrades', async () => {
    const updates = []
    const paid = { id: 'p1', state: 'paid', paid_at: '2026-08-08T10:00:00Z' }
    expect(await markOfferPurchaseState({ db: makeUpdateDb(updates), purchase: paid, providerState: 'completed' })).toEqual({ changed: false, state: 'paid' })
    expect(await markOfferPurchaseState({ db: makeUpdateDb(updates), purchase: paid, providerState: 'failed' })).toEqual({ changed: false, state: 'paid' })
    expect(updates).toHaveLength(0)
  })
  it('failed / cancelled map through; unknown states no-op', async () => {
    const updates = []
    const created = { id: 'p1', state: 'created', paid_at: null }
    expect((await markOfferPurchaseState({ db: makeUpdateDb(updates), purchase: created, providerState: 'failed' })).state).toBe('failed')
    expect((await markOfferPurchaseState({ db: makeUpdateDb(updates), purchase: created, providerState: 'cancelled' })).state).toBe('cancelled')
    expect(await markOfferPurchaseState({ db: makeUpdateDb(updates), purchase: created, providerState: 'processing' })).toEqual({ changed: false, state: 'created' })
    expect(updates.map((u) => u.state)).toEqual(['failed', 'cancelled'])
    expect(updates.every((u) => !u.paid_at)).toBe(true)
  })
})

const purchase = {
  id: 'p1', location_id: 'loc1', buyer_name: 'Jane Doe',
  buyer_email: 'Jane@Example.com', buyer_phone: '0871234567', amount_cents: 49700,
}

function makeContactDb({ existingTags = [] } = {}) {
  const updates = []
  const db = {
    _table: null,
    from(t) { this._table = t; return this },
    select() { return this },
    update(u) { updates.push({ table: this._table, patch: u }); return this },
    eq() { return this },
    maybeSingle: async () => ({ data: db._table === 'contacts' ? { tags: existingTags } : null }),
  }
  return { db, updates }
}

describe('linkOrCreateContactForPurchase', () => {
  it('delegates to findOrCreateRaceContact with restrictToOrg and links the purchase', async () => {
    const { db, updates } = makeContactDb()
    const r = await linkOrCreateContactForPurchase(db, purchase)
    expect(r.contactId).toBe('contact-1')
    expect(findOrCreateRaceContact).toHaveBeenCalledWith(expect.objectContaining({
      locationId: 'loc1', email: 'Jane@Example.com', name: 'Jane Doe', phone: '0871234567', restrictToOrg: true,
    }))
    expect(updates.some((u) => u.table === 'offer_purchases' && u.patch.contact_id === 'contact-1')).toBe(true)
  })
  it('tags BOTH systems: contact_tags row + contacts.tags array', async () => {
    const { db, updates } = makeContactDb({ existingTags: ['member'] })
    await linkOrCreateContactForPurchase(db, purchase)
    expect(writeContactTag).toHaveBeenCalledWith(db, expect.objectContaining({ contactId: 'contact-1', locationId: 'loc1', tag: OFFER_SALE_TAG }))
    const tagUpdate = updates.find((u) => u.table === 'contacts')
    expect(tagUpdate.patch.tags).toEqual(['member', OFFER_SALE_TAG])
  })
  it('does not duplicate an already-present array tag', async () => {
    const { db, updates } = makeContactDb({ existingTags: [OFFER_SALE_TAG] })
    await linkOrCreateContactForPurchase(db, purchase)
    expect(updates.find((u) => u.table === 'contacts')).toBeUndefined()
  })
  it('no contact resolvable → returns null contactId, writes nothing', async () => {
    findOrCreateRaceContact.mockResolvedValueOnce(null)
    const { db, updates } = makeContactDb()
    const r = await linkOrCreateContactForPurchase(db, purchase)
    expect(r.contactId).toBeNull()
    expect(updates).toHaveLength(0)
    expect(writeContactTag).not.toHaveBeenCalled()
  })
})

describe('notifyStaffOfPaidPurchase', () => {
  const offer = { name: '3 Month Membership', bonus_headline: '+2 WEEKS FREE' }
  it('resolves the org from the location and sends an ops alert', async () => {
    const db = {
      from() { return this }, select() { return this }, eq() { return this },
      maybeSingle: async () => ({ data: { organization_id: 'org1', name: 'UN1T Stillorgan' } }),
    }
    const r = await notifyStaffOfPaidPurchase(db, purchase, offer)
    expect(r.sent).toBe(true)
    expect(sendOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org1', locationId: 'loc1',
      subject: expect.stringContaining('3 Month Membership'),
    }), expect.objectContaining({ db }))
    const alert = sendOpsAlert.mock.calls[0][0]
    expect(alert.htmlBody).toContain('Jane Doe')
    expect(alert.htmlBody).toContain('€497')
    expect(alert.htmlBody).toContain('Glofox')
  })
  it('missing org → sent:false, no alert', async () => {
    const db = {
      from() { return this }, select() { return this }, eq() { return this },
      maybeSingle: async () => ({ data: null }),
    }
    expect((await notifyStaffOfPaidPurchase(db, purchase, offer)).sent).toBe(false)
    expect(sendOpsAlert).not.toHaveBeenCalled()
  })
})
