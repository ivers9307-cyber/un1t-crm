// MOBILEFUNNEL.1 — the offer forms' consent rule: ticked opts in; unticked
// opts out a contact this request created; unticked leaves an existing one alone.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const apply = vi.hoisted(() => vi.fn(async () => ({ ok: true, changed: [] })))
vi.mock('./marketing-consent.js', () => ({ applyFormMarketingConsent: apply }))

import { applyOfferFormConsent } from './offer-form-consent'

const args = { contactId: 'c1', source: 'corp_promo', ipAddress: '1.2.3.4', locationId: 'L1' }
beforeEach(() => apply.mockClear())

describe('applyOfferFormConsent', () => {
  it('ticked opts in, new or existing', async () => {
    for (const created of [true, false]) {
      apply.mockClear()
      expect((await applyOfferFormConsent({}, { ...args, created, consent: true })).applied).toBe('opt_in')
      expect(apply).toHaveBeenCalledWith({}, { contactId: 'c1', consent: true, source: 'corp_promo', ipAddress: '1.2.3.4', locationId: 'L1' })
    }
  })
  it('unticked and created by this request opts out', async () => {
    expect((await applyOfferFormConsent({}, { ...args, created: true, consent: false })).applied).toBe('opt_out')
    expect(apply).toHaveBeenCalledWith({}, expect.objectContaining({ contactId: 'c1', consent: false, locationId: 'L1' }))
  })
  it('unticked (or absent) and the contact already existed writes nothing', async () => {
    expect((await applyOfferFormConsent({}, { ...args, created: false, consent: false })).applied).toBeNull()
    expect((await applyOfferFormConsent({}, { ...args, created: false })).applied).toBeNull()
    expect(apply).not.toHaveBeenCalled()
  })
})
