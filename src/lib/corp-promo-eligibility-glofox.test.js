// NEWSTART.1b — who may claim a Glofox promo. Never a database.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { glofoxCorpPromoEligibility } from './corp-promo-eligibility-glofox'
import { makeDb, LOC, ORG } from './un1t-online-write.test-helpers.js'

const OTHER_LOC = 'loc-other'
const ME = 'c-me'
const TWIN = 'c-twin'
const KEY = 'newstart-3-free'

const contacts = () => [
  { id: ME, organization_id: ORG, email: 'me@work.ie', wa_phone: '353871234567', location_id: LOC, glofox_membership_status: null },
  { id: TWIN, organization_id: ORG, email: 'me@home.ie', wa_phone: '353871234567', location_id: LOC, glofox_membership_status: null },
  { id: 'c-stranger', organization_id: ORG, email: 'x@y.ie', wa_phone: '353870000000', location_id: LOC, glofox_membership_status: 'member' },
]
const run = (tables = {}, over = {}, contactRows = contacts()) => {
  const { db } = makeDb({ tables: { contacts: contactRows, ...tables } })
  return glofoxCorpPromoEligibility(db, {
    locationId: LOC, organizationId: ORG, contactId: ME, email: 'me@work.ie', phone: '087 123 4567', promoKey: KEY, ...over,
  })
}
const claim = (status, contact_id = ME, over = {}) => ({ id: `cl-${status}-${contact_id}`, location_id: LOC, contact_id, promo_key: KEY, status, ...over })

describe('glofoxCorpPromoEligibility', () => {
  it('a clean person is eligible', async () => {
    expect(await run()).toEqual({ ok: true, eligible: true })
  })

  it('an active contact_studios membership at the studio is active_member', async () => {
    const out = await run({ contact_studios: [{ contact_id: TWIN, location_id: LOC, membership_status: 'active' }] })
    expect(out).toEqual({ ok: true, eligible: false, reason: 'active_member' })
  })

  it('an ended membership or an active one at another studio is not', async () => {
    expect(await run({ contact_studios: [
      { contact_id: ME, location_id: LOC, membership_status: 'ended' },
      { contact_id: ME, location_id: OTHER_LOC, membership_status: 'active' },
    ] })).toEqual({ ok: true, eligible: true })
  })

  it('glofox_membership_status member on a contact homed at the studio is active_member', async () => {
    const rows = contacts().map((c) => (c.id === ME ? { ...c, glofox_membership_status: 'member' } : c))
    expect(await run({}, {}, rows)).toEqual({ ok: true, eligible: false, reason: 'active_member' })
  })

  it('a member status homed at another studio, or a non-member status, does not count', async () => {
    const elsewhere = contacts().map((c) => (c.id === ME ? { ...c, glofox_membership_status: 'member', location_id: OTHER_LOC } : c))
    expect(await run({}, {}, elsewhere)).toEqual({ ok: true, eligible: true })
    for (const s of ['trial', 'credit_member', 'classpass_payg']) {
      const rows = contacts().map((c) => (c.id === ME ? { ...c, glofox_membership_status: s } : c))
      expect(await run({}, {}, rows)).toEqual({ ok: true, eligible: true })
    }
  })

  it('a granted claim on a sibling contact matched by mobile is already_claimed', async () => {
    expect(await run({ corp_promo_claims: [claim('granted', TWIN)] })).toEqual({ ok: true, eligible: false, reason: 'already_claimed' })
  })

  it('help_requested is already_claimed; ineligible, handled and failed are not', async () => {
    expect((await run({ corp_promo_claims: [claim('help_requested')] })).reason).toBe('already_claimed')
    for (const s of ['ineligible', 'handled', 'failed']) {
      expect(await run({ corp_promo_claims: [claim(s)] })).toEqual({ ok: true, eligible: true })
    }
  })

  it('a processing claim is in_progress', async () => {
    expect(await run({ corp_promo_claims: [claim('processing')] })).toEqual({ ok: true, eligible: false, reason: 'in_progress' })
  })

  it('already_claimed wins over in_progress; active_member wins over both', async () => {
    const claims = [claim('processing'), claim('granted', TWIN)]
    expect((await run({ corp_promo_claims: claims })).reason).toBe('already_claimed')
    const out = await run({ corp_promo_claims: claims, contact_studios: [{ contact_id: ME, location_id: LOC, membership_status: 'active' }] })
    expect(out.reason).toBe('active_member')
  })

  it('claims for another promo or another studio do not count', async () => {
    expect(await run({ corp_promo_claims: [claim('granted', ME, { promo_key: 'other' }), claim('granted', ME, { location_id: OTHER_LOC })] }))
      .toEqual({ ok: true, eligible: true })
  })

  it('prior trials and training never refuse', async () => {
    expect(await run({
      class_bookings: [{ id: 'cb', location_id: LOC, contact_id: ME, status: 'ATTENDED' }],
      trial_purchases: [{ id: 'tp', location_id: LOC, contact_id: ME, status: 'granted' }],
    })).toEqual({ ok: true, eligible: true })
  })

  it('a stranger with a different email and mobile is not this person', async () => {
    expect(await run({ corp_promo_claims: [claim('granted', 'c-stranger')] })).toEqual({ ok: true, eligible: true })
  })

  it('a read error on corp_promo_claims is ok:false', async () => {
    const { db } = makeDb({ tables: { contacts: contacts() }, fail: { 'corp_promo_claims.select': { code: '57014' } } })
    expect(await glofoxCorpPromoEligibility(db, { locationId: LOC, organizationId: ORG, contactId: ME, email: 'me@work.ie', phone: '0871234567', promoKey: KEY })).toEqual({ ok: false })
  })

  it('a read error on contact_studios is ok:false', async () => {
    const { db } = makeDb({ tables: { contacts: contacts() }, fail: { 'contact_studios.select': { code: '57014' } } })
    expect(await glofoxCorpPromoEligibility(db, { locationId: LOC, organizationId: ORG, contactId: ME, promoKey: KEY })).toEqual({ ok: false })
  })
})
