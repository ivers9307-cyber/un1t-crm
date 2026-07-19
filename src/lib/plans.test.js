import { describe, it, expect } from 'vitest'
import { pickActiveVersion, resolveAllowances } from './plans.js'

const v = (effective_from, extra = {}) => ({ effective_from, ...extra })

describe('pickActiveVersion', () => {
  it('picks the latest version effective on or before the date', () => {
    const versions = [
      v('2026-01-01', { price_cents: 9900 }),
      v('2026-06-01', { price_cents: 10900 }),
      v('2026-09-01', { price_cents: 11900 }),
    ]
    expect(pickActiveVersion(versions, '2026-07-19').price_cents).toBe(10900)
  })

  it('includes a version whose effective_from is exactly the date', () => {
    const versions = [v('2026-01-01'), v('2026-07-19', { price_cents: 5 })]
    expect(pickActiveVersion(versions, '2026-07-19').price_cents).toBe(5)
  })

  it('ignores scheduled (future) versions', () => {
    const versions = [v('2026-09-01'), v('2027-01-01')]
    expect(pickActiveVersion(versions, '2026-07-19')).toBeNull()
  })

  it('is order-independent', () => {
    const versions = [
      v('2026-06-01', { price_cents: 2 }),
      v('2026-01-01', { price_cents: 1 }),
    ]
    expect(pickActiveVersion(versions, '2026-12-01').price_cents).toBe(2)
    expect(pickActiveVersion([...versions].reverse(), '2026-12-01').price_cents).toBe(2)
  })

  it('returns null for empty / missing input', () => {
    expect(pickActiveVersion([], '2026-07-19')).toBeNull()
    expect(pickActiveVersion(null, '2026-07-19')).toBeNull()
  })
})

describe('resolveAllowances', () => {
  const tier = {
    allowances: { wa_template_send: 500, email_send: 2500, ai_message: 0 },
    unit_rates_cents: { wa_marketing: 9, wa_utility: 4, email_per_1k: 400, ai_message: 5 },
    features: { ai_agent: false, custom_email_domain: false },
  }

  it('returns null for an unpinned location (no tier version)', () => {
    expect(resolveAllowances(null)).toBeNull()
    expect(resolveAllowances(undefined, [])).toBeNull()
  })

  it('passes tier allowances, rates and features through with no add-ons', () => {
    const r = resolveAllowances(tier, [])
    expect(r.allowances).toEqual({ wa_template_send: 500, email_send: 2500, ai_message: 0 })
    expect(r.unitRatesCents).toEqual(tier.unit_rates_cents)
    expect(r.features).toEqual({ ai_agent: false, custom_email_domain: false })
  })

  it('sums add-on allowances onto the tier per meter', () => {
    const addon = { allowances: { ai_message: 1000 }, features: {} }
    const r = resolveAllowances(tier, [addon])
    expect(r.allowances.ai_message).toBe(1000)
    expect(r.allowances.wa_template_send).toBe(500)
  })

  it('ORs features — an add-on grants but never revokes', () => {
    const addon = { allowances: {}, features: { custom_email_domain: true } }
    const r = resolveAllowances(tier, [addon])
    expect(r.features.custom_email_domain).toBe(true)
    // A second add-on with the flag false must not revoke the grant.
    const r2 = resolveAllowances(tier, [addon, { features: { custom_email_domain: false } }])
    expect(r2.features.custom_email_domain).toBe(true)
  })

  it('takes overage rates from the tier only, ignoring add-on rates', () => {
    const addon = { allowances: {}, unit_rates_cents: { wa_marketing: 999 }, features: {} }
    expect(resolveAllowances(tier, [addon]).unitRatesCents.wa_marketing).toBe(9)
  })

  it('treats missing / malformed allowance values as zero', () => {
    const r = resolveAllowances(
      { allowances: { email_send: 'not-a-number' }, features: {} },
      [{ allowances: { wa_template_send: null } }]
    )
    expect(r.allowances).toEqual({ wa_template_send: 0, email_send: 0, ai_message: 0 })
  })

  it('ignores unknown meter keys from DB jsonb (structure lives in code)', () => {
    const r = resolveAllowances(
      { allowances: { mystery_meter: 42, email_send: 10 }, features: {} },
      []
    )
    expect(r.allowances.mystery_meter).toBeUndefined()
    expect(r.allowances.email_send).toBe(10)
  })
})
