// CORPPROMO.1 — who may claim a /corp promo. Never a database.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { corpPromoEligibility } from './corp-promo-eligibility'
import { makeDb, LOC, ORG } from './un1t-online-write.test-helpers.js'

const OTHER_LOC = 'loc-stillorgan'
const ME = 'c-me'
const TWIN = 'c-twin' // same mobile, other email
const PRODUCT = 'trial-product'

const contacts = () => [
  { id: ME, organization_id: ORG, email: 'me@work.ie', wa_phone: '353871234567' },
  { id: TWIN, organization_id: ORG, email: 'me@home.ie', wa_phone: '353871234567' },
  { id: 'c-stranger', organization_id: ORG, email: 'x@y.ie', wa_phone: '353870000000' },
]
const run = (tables = {}, over = {}) => {
  const { db } = makeDb({ tables: { contacts: contacts(), ...tables } })
  return corpPromoEligibility(db, {
    locationId: LOC, organizationId: ORG, contactId: ME, email: 'me@work.ie', phone: '087 123 4567', trialProductId: PRODUCT, ...over,
  })
}

describe('corpPromoEligibility', () => {
  it('a clean person is eligible', async () => {
    expect(await run()).toEqual({ ok: true, eligible: true })
  })

  it('a free trial on the ledger for a contact sharing the mobile stops it', async () => {
    const out = await run({ un1t_write_events: [{ id: 'w1', location_id: LOC, contact_id: TWIN, op: 'trial', stage: 'done' }] })
    expect(out).toEqual({ ok: true, eligible: false, reason: 'free_trial_used' })
  })

  it('a re-grant or an earlier promo grant in doubt counts as a free trial; a refused one does not', async () => {
    expect((await run({ un1t_write_events: [{ id: 'w1', location_id: LOC, contact_id: ME, op: 'trial_regrant', stage: 'sent' }] })).reason).toBe('free_trial_used')
    expect((await run({ un1t_write_events: [{ id: 'w1', location_id: LOC, contact_id: ME, op: 'promo_grant', stage: 'unknown' }] })).reason).toBe('free_trial_used')
    expect(await run({ un1t_write_events: [{ id: 'w1', location_id: LOC, contact_id: ME, op: 'promo_grant', stage: 'refused' }] })).toEqual({ ok: true, eligible: true })
  })

  it("the free trial product on a mirrored transaction of the person's account stops it; a paid pack alone does not", async () => {
    const clients = [{ id: 'cl', location_id: LOC, un1t_user_id: 'u1', contact_id: ME }]
    expect((await run({ un1t_clients: clients, un1t_transactions: [{ id: 't', location_id: LOC, un1t_user_id: 'u1', product_id: PRODUCT }] })).reason).toBe('free_trial_used')
    expect(await run({ un1t_clients: clients, un1t_transactions: [{ id: 't', location_id: LOC, un1t_user_id: 'u1', product_id: 'paid-pack' }] })).toEqual({ ok: true, eligible: true })
  })

  it('a booking that was not cancelled is trained; only cancelled ones are not', async () => {
    expect((await run({ un1t_bookings: [{ id: 'b', location_id: LOC, contact_id: ME, status: 'attended' }] })).reason).toBe('trained')
    expect(await run({ un1t_bookings: [{ id: 'b', location_id: LOC, contact_id: ME, status: 'cancelled' }] })).toEqual({ ok: true, eligible: true })
    expect((await run({ class_bookings: [{ id: 'cb', location_id: LOC, contact_id: TWIN, status: 'BOOKED' }] })).reason).toBe('trained')
  })

  it('subscription or membership history is trained', async () => {
    expect((await run({ un1t_subscriptions: [{ id: 's', location_id: LOC, contact_id: ME, status: 'ended' }] })).reason).toBe('trained')
    expect((await run({ contact_studios: [{ contact_id: ME, location_id: LOC, membership_status: 'ended' }] })).reason).toBe('trained')
  })

  it('history at another studio of the organisation does not count', async () => {
    const out = await run({
      un1t_bookings: [{ id: 'b', location_id: OTHER_LOC, contact_id: ME, status: 'attended' }],
      contact_studios: [{ contact_id: ME, location_id: OTHER_LOC, membership_status: 'active' }],
      un1t_write_events: [{ id: 'w', location_id: OTHER_LOC, contact_id: ME, op: 'trial', stage: 'done' }],
    })
    expect(out).toEqual({ ok: true, eligible: true })
  })

  it('a stranger with a different email and mobile is not this person', async () => {
    expect(await run({ un1t_bookings: [{ id: 'b', location_id: LOC, contact_id: 'c-stranger', status: 'attended' }] })).toEqual({ ok: true, eligible: true })
  })

  it('any failed read is ok:false, never eligible', async () => {
    const { db } = makeDb({ tables: { contacts: contacts() }, fail: { 'un1t_bookings.select': { code: '57014' } } })
    expect(await corpPromoEligibility(db, { locationId: LOC, organizationId: ORG, contactId: ME, email: 'me@work.ie', phone: '0871234567' })).toEqual({ ok: false })
  })
})
