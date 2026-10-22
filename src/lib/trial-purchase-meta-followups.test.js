import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ capi: vi.fn(), warn: vi.fn() }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: mocks.capi }))
vi.mock('@/lib/log', () => ({ logWarn: mocks.warn }))

import { sendTrialScheduleFollowup, sendTrialSubscribeFollowup, findRecentGrantedTrialPurchase } from './trial-purchase-meta-followups'

const NOW = Date.parse('2026-10-22T10:00:00Z')
const PURCHASE = {
  id: 'tp1', location_id: 'loc1', contact_id: 'c1', customer_email: 'a@b.com', customer_phone: '+353850000001',
  first_name: 'Ava', last_name: 'Byrne', membership_id: 'm-trial', plan_code: 'p1', product_name: 'The 14 Day Reset',
  currency: 'EUR', granted_at: '2026-10-21T23:00:00Z', attribution: { fbc: 'fb.1.x', event_source_url: 'https://www.un1tdublin.com/trial' },
}

// A db whose trial_purchases select answers `rows`, whose CAS update answers
// `claimed`, and which records every update.
function makeDb({ rows = [PURCHASE], claimed = true, readError = null } = {}) {
  const updates = []
  const selectCalls = []
  const db = {
    from: (table) => ({
      select: () => {
        const chain = {
          eq: (c, v) => { selectCalls.push(['eq', c, v]); return chain },
          gte: (c, v) => { selectCalls.push(['gte', c, v]); return chain },
          order: () => chain,
          limit: async () => ({ data: readError ? null : rows, error: readError }),
        }
        return chain
      },
      update: (fields) => {
        const call = { table, fields, filters: [] }
        updates.push(call)
        const chain = {
          eq: (c, v) => { call.filters.push(['eq', c, v]); return chain },
          is: (c, v) => { call.filters.push(['is', c, v]); return chain },
          select: async () => ({ data: call.filters.some((f) => f[0] === 'is') && !claimed ? [] : [{ id: 'tp1' }], error: null }),
        }
        return chain
      },
    }),
  }
  return { db, updates, selectCalls }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.capi.mockResolvedValue({ sent: true })
})

describe('findRecentGrantedTrialPurchase', () => {
  it('asks for the latest granted purchase of this contact at this studio inside the window', async () => {
    const { db, selectCalls } = makeDb()
    const p = await findRecentGrantedTrialPurchase(db, { contactId: 'c1', locationId: 'loc1', withinDays: 30, now: NOW })
    expect(p.id).toBe('tp1')
    expect(selectCalls).toContainEqual(['eq', 'contact_id', 'c1'])
    expect(selectCalls).toContainEqual(['eq', 'location_id', 'loc1'])
    expect(selectCalls).toContainEqual(['eq', 'status', 'granted'])
    expect(selectCalls).toContainEqual(['gte', 'granted_at', '2026-09-22T10:00:00.000Z'])
  })
  it('throws on a read error (the callers turn it into a warn)', async () => {
    const { db } = makeDb({ readError: new Error('db down') })
    await expect(findRecentGrantedTrialPurchase(db, { contactId: 'c1', locationId: 'loc1', withinDays: 30 })).rejects.toThrow(/db down/)
  })
})

describe('sendTrialScheduleFollowup (TRIALFOLLOWUP.1)', () => {
  it('a BOOKED booking sends one Schedule with the purchase identity, after claiming the stamp', async () => {
    const { db, updates } = makeDb()
    const r = await sendTrialScheduleFollowup(db, { contactId: 'c1', locationId: 'loc1', booking: { status: 'BOOKED' }, now: NOW })
    expect(r).toEqual({ sent: true, purchaseId: 'tp1' })
    expect(updates).toHaveLength(1)
    expect(updates[0].fields.attribution).toMatchObject({ fbc: 'fb.1.x', meta_schedule_sent_at: '2026-10-22T10:00:00.000Z' })
    expect(updates[0].filters).toContainEqual(['is', 'attribution->>meta_schedule_sent_at', null])
    expect(mocks.capi).toHaveBeenCalledWith(db, expect.objectContaining({
      eventName: 'Schedule', eventId: 'trialschedule-tp1', locationId: 'loc1', email: 'a@b.com', phone: '+353850000001',
      firstName: 'Ava', lastName: 'Byrne', externalId: 'c1', fbc: 'fb.1.x', contentName: 'The 14 Day Reset',
      eventSourceUrl: 'https://www.un1tdublin.com/trial',
    }))
  })
  it('a waitlist place is not a booking', async () => {
    const { db, updates } = makeDb()
    expect(await sendTrialScheduleFollowup(db, { contactId: 'c1', locationId: 'loc1', booking: { status: 'WAITING' } })).toEqual({ sent: false, reason: 'not_booked' })
    expect(updates).toHaveLength(0)
    expect(mocks.capi).not.toHaveBeenCalled()
  })
  it('no granted trial in the window → nothing', async () => {
    const { db } = makeDb({ rows: [] })
    expect(await sendTrialScheduleFollowup(db, { contactId: 'c1', locationId: 'loc1', booking: { status: 'BOOKED' } })).toEqual({ sent: false, reason: 'no_trial_purchase' })
    expect(mocks.capi).not.toHaveBeenCalled()
  })
  it('a second delivery loses the claim and sends nothing', async () => {
    const { db } = makeDb({ claimed: false })
    expect(await sendTrialScheduleFollowup(db, { contactId: 'c1', locationId: 'loc1', booking: { status: 'BOOKED' } })).toEqual({ sent: false, reason: 'already_sent' })
    expect(mocks.capi).not.toHaveBeenCalled()
  })
  it('a send that did not land releases the stamp so the next booking retries', async () => {
    mocks.capi.mockResolvedValueOnce({ sent: false, reason: 'api_error' })
    const { db, updates } = makeDb()
    expect(await sendTrialScheduleFollowup(db, { contactId: 'c1', locationId: 'loc1', booking: { status: 'BOOKED' }, now: NOW })).toEqual({ sent: false, reason: 'api_error' })
    expect(updates).toHaveLength(2)
    expect(updates[1].fields.attribution).not.toHaveProperty('meta_schedule_sent_at')
    expect(updates[1].fields.attribution).toMatchObject({ fbc: 'fb.1.x' })
  })
  it('never throws: a read error is a warn and { sent: false }', async () => {
    const { db } = makeDb({ readError: new Error('db down') })
    expect(await sendTrialScheduleFollowup(db, { contactId: 'c1', locationId: 'loc1', booking: { status: 'BOOKED' } })).toEqual({ sent: false, reason: 'exception' })
    expect(mocks.warn).toHaveBeenCalled()
  })
})

describe('sendTrialSubscribeFollowup (TRIALFOLLOWUP.1)', () => {
  const MEMBERSHIP = { id: 'um1', status: 'ACTIVE', price: 99, membership_definition: { id: 'm-monthly', name: '2) The Monthly Membership' } }

  it('an ACTIVE non-trial membership sends one Subscribe with the price as value', async () => {
    const { db, updates } = makeDb()
    const r = await sendTrialSubscribeFollowup(db, { contactId: 'c1', locationId: 'loc1', membership: MEMBERSHIP, now: NOW })
    expect(r).toEqual({ sent: true, purchaseId: 'tp1' })
    expect(updates[0].fields.attribution).toMatchObject({ meta_subscribe_sent_at: '2026-10-22T10:00:00.000Z' })
    expect(updates[0].filters).toContainEqual(['is', 'attribution->>meta_subscribe_sent_at', null])
    expect(mocks.capi).toHaveBeenCalledWith(db, expect.objectContaining({
      eventName: 'Subscribe', eventId: 'trialsubscribe-tp1', value: 99, currency: 'EUR', orderId: 'um1',
      contentName: '2) The Monthly Membership', contentType: 'product', externalId: 'c1',
    }))
  })
  it('the trial plan itself is not a subscription', async () => {
    const { db } = makeDb()
    const r = await sendTrialSubscribeFollowup(db, { contactId: 'c1', locationId: 'loc1', membership: { ...MEMBERSHIP, membership_definition: { id: 'm-trial', name: 'The 14 Day Reset' } } })
    expect(r).toEqual({ sent: false, reason: 'trial_plan_itself' })
    expect(mocks.capi).not.toHaveBeenCalled()
  })
  it('a membership that is not ACTIVE sends nothing', async () => {
    const { db } = makeDb()
    expect(await sendTrialSubscribeFollowup(db, { contactId: 'c1', locationId: 'loc1', membership: { ...MEMBERSHIP, status: 'PENDING' } })).toEqual({ sent: false, reason: 'not_active' })
  })
  it('an unreadable price sends the Subscribe without a value', async () => {
    const { db } = makeDb()
    await sendTrialSubscribeFollowup(db, { contactId: 'c1', locationId: 'loc1', membership: { ...MEMBERSHIP, price: 'n/a' } })
    expect(mocks.capi).toHaveBeenCalledWith(db, expect.objectContaining({ eventName: 'Subscribe', value: undefined }))
  })
  it('no granted trial in the window → nothing', async () => {
    const { db } = makeDb({ rows: [] })
    expect(await sendTrialSubscribeFollowup(db, { contactId: 'c1', locationId: 'loc1', membership: MEMBERSHIP })).toEqual({ sent: false, reason: 'no_trial_purchase' })
  })
})
