// CLASSFIRST.1 — the funded booking queued after a grant: one
// class_booking_requests row marked funded_by, the QStash nudge, a unique
// violation as "already queued", a failed insert logged and returned, never
// thrown; no class on the row, nothing to queue.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ push: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/qstash', () => ({ publishQueuePush: mocks.push, CLASS_BOOKINGS_WORKER_PATH: '/api/webhooks/qstash/class-bookings' }))
vi.mock('@/lib/log', () => ({ logError: mocks.logError, logWarn: vi.fn() }))

import { queueFundedClassBooking, fundedBookingFromRow, FUNDED_BY, FUNDED_NO_BALANCE } from './class-first-booking'

function makeDb({ answer = { data: { id: 'cbr-1' }, error: null }, throws = null } = {}) {
  const inserts = []
  const db = {
    from: (table) => ({
      insert: (row) => {
        inserts.push({ table, row })
        return { select: () => ({ maybeSingle: async () => { if (throws) throw throws; return answer } }) }
      },
    }),
  }
  return { db, inserts }
}

const PURCHASE = {
  id: 'tp-1', location_id: 'loc-1', contact_id: 'c-1', page_id: 'p-1',
  customer_name: 'Ava Byrne', first_name: 'Ava', last_name: 'Byrne', customer_email: 'ava@example.com', customer_phone: '+353850000001',
  class_event_id: 'ev-1', class_name: 'S&C', class_starts_at: '2099-01-05T11:00:00.000Z',
  terms_accepted_at: '2026-11-01T10:00:00.000Z', terms_source: 'website', terms_version: 'v3',
}

beforeEach(() => { vi.clearAllMocks(); mocks.push.mockResolvedValue(undefined) })

describe('fundedBookingFromRow', () => {
  it('builds the queue arguments off a purchase row, terms included', () => {
    expect(fundedBookingFromRow(PURCHASE, { fundedBy: FUNDED_BY.trialPurchase })).toEqual({
      fundedBy: 'trial_purchase', fundedById: 'tp-1', locationId: 'loc-1', contactId: 'c-1', pageId: 'p-1',
      eventId: 'ev-1', className: 'S&C', startsAt: '2099-01-05T11:00:00.000Z',
      customer: { name: 'Ava Byrne', email: 'ava@example.com', phone: '+353850000001' },
      terms: { terms_accepted_at: '2026-11-01T10:00:00.000Z', terms_source: 'website', terms_version: 'v3' },
    })
  })
  it('a claim row with no customer_name joins first and last; no terms is {}', () => {
    const { customer_name: _n, terms_accepted_at: _t, ...claim } = PURCHASE
    const a = fundedBookingFromRow(claim, { fundedBy: FUNDED_BY.corpPromo })
    expect(a.customer.name).toBe('Ava Byrne')
    expect(a.terms).toEqual({})
    expect(a.fundedBy).toBe('corp_promo')
  })
  it('no class, or no contact, is null', () => {
    expect(fundedBookingFromRow({ ...PURCHASE, class_event_id: null }, { fundedBy: 'trial_purchase' })).toBeNull()
    expect(fundedBookingFromRow({ ...PURCHASE, contact_id: null }, { fundedBy: 'trial_purchase' })).toBeNull()
    expect(fundedBookingFromRow(null, { fundedBy: 'trial_purchase' })).toBeNull()
  })
})

describe('queueFundedClassBooking', () => {
  const args = fundedBookingFromRow(PURCHASE, { fundedBy: FUNDED_BY.trialPurchase })

  it('inserts one queued row, no trial pair, marked funded, and nudges QStash with the dash-only dedup id', async () => {
    const { db, inserts } = makeDb()
    expect(await queueFundedClassBooking(db, args)).toEqual({ queued: true, id: 'cbr-1' })
    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe('class_booking_requests')
    expect(inserts[0].row).toEqual({
      terms_accepted_at: '2026-11-01T10:00:00.000Z', terms_source: 'website', terms_version: 'v3',
      page_id: 'p-1', location_id: 'loc-1', contact_id: 'c-1', glofox_event_id: 'ev-1', class_name: 'S&C', starts_at: '2099-01-05T11:00:00.000Z',
      customer_name: 'Ava Byrne', customer_email: 'ava@example.com', customer_phone: '+353850000001',
      trial_membership_id: null, trial_plan_code: null, funded_by: 'trial_purchase', funded_by_id: 'tp-1', status: 'queued',
    })
    expect(mocks.push).toHaveBeenCalledWith({ path: '/api/webhooks/qstash/class-bookings', body: { id: 'cbr-1' }, deduplicationId: 'class-booking-cbr-1' })
    expect(mocks.logError).not.toHaveBeenCalled()
  })
  it('a unique violation is already queued: no nudge, no error', async () => {
    const { db } = makeDb({ answer: { data: null, error: { code: '23505' } } })
    expect(await queueFundedClassBooking(db, args)).toEqual({ queued: true, id: null, deduped: true })
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.logError).not.toHaveBeenCalled()
  })
  it('a failed or thrown insert is logged with ids and returned, never thrown', async () => {
    const { db } = makeDb({ answer: { data: null, error: { code: '42501' } } })
    expect(await queueFundedClassBooking(db, args)).toEqual({ queued: false, reason: '42501' })
    expect(mocks.logError).toHaveBeenCalledWith('class-first', 'funded booking not queued', expect.objectContaining({ fundedById: 'tp-1', eventId: 'ev-1', code: '42501' }))
    const thrown = makeDb({ throws: new Error('down') })
    expect(await queueFundedClassBooking(thrown.db, args)).toEqual({ queued: false, reason: 'insert_failed' })
  })
  it('a pushed nudge that fails leaves the row queued', async () => {
    mocks.push.mockRejectedValueOnce(new Error('qstash down'))
    const { db } = makeDb()
    expect(await queueFundedClassBooking(db, args)).toEqual({ queued: true, id: 'cbr-1' })
  })
  it('incomplete arguments queue nothing', async () => {
    const { db, inserts } = makeDb()
    expect(await queueFundedClassBooking(db, { ...args, eventId: null })).toEqual({ queued: false, reason: 'incomplete' })
    expect(inserts).toHaveLength(0)
  })
  it('names the card reason the processors file for an empty balance', () => {
    expect(FUNDED_NO_BALANCE).toBe('funded_no_balance')
  })
})
