import { describe, it, expect } from 'vitest'
import { paidTrialConfigFromBlocks, formatTrialPrice, trialTicks, trialPurchasePublicState } from './paid-trial'
import { newBlockOfType } from './landing-page-blocks'

const sellable = () => ({ ...newBlockOfType('paid_trial'), membership_id: 'm1', plan_code: 'p1' })

describe('paidTrialConfigFromBlocks (PAIDTRIAL.1)', () => {
  it('null without a paid_trial block', () => {
    expect(paidTrialConfigFromBlocks([{ id: 'h', type: 'hero' }], 'stillorgan')).toBeNull()
    expect(paidTrialConfigFromBlocks(null, 'stillorgan')).toBeNull()
  })
  it('the default block ships without a Glofox product and so sells nothing', () => {
    expect(newBlockOfType('paid_trial').membership_id).toBe('')
    expect(paidTrialConfigFromBlocks([newBlockOfType('paid_trial')], 'stillorgan')).toBeNull()
  })
  it('a half-configured product (one id) sells nothing', () => {
    expect(paidTrialConfigFromBlocks([{ ...sellable(), plan_code: '' }], 'stillorgan')).toBeNull()
    expect(paidTrialConfigFromBlocks([{ ...sellable(), membership_id: '  ' }], 'stillorgan')).toBeNull()
  })
  it('reads the product with the block price, never a client value', () => {
    const c = paidTrialConfigFromBlocks([sellable()], 'stillorgan')
    expect(c).toMatchObject({ priceCents: 3900, currency: 'EUR', durationDays: 14, membershipId: 'm1', planCode: 'p1', productName: '2 Week Trial' })
    expect(c.tag).toBe('stillorgan-trial')
    expect(c.leadSource).toBe('meta_trial')
  })
  it('refuses a price outside the sane band', () => {
    expect(paidTrialConfigFromBlocks([{ ...sellable(), price_cents: 0 }], 'stillorgan')).toBeNull()
    expect(paidTrialConfigFromBlocks([{ ...sellable(), price_cents: 50 }], 'stillorgan')).toBeNull()
    expect(paidTrialConfigFromBlocks([{ ...sellable(), price_cents: 999_999 }], 'stillorgan')).toBeNull()
    expect(paidTrialConfigFromBlocks([{ ...sellable(), price_cents: '3900' }], 'stillorgan')?.priceCents).toBe(3900)
  })
  it('falls back to 14 days on a malformed duration and keeps a sane one', () => {
    expect(paidTrialConfigFromBlocks([{ ...sellable(), duration_days: 'x' }], 'stillorgan').durationDays).toBe(14)
    expect(paidTrialConfigFromBlocks([{ ...sellable(), duration_days: 28 }], 'stillorgan').durationDays).toBe(28)
    expect(paidTrialConfigFromBlocks([{ ...sellable(), duration_days: 0 }], 'stillorgan').durationDays).toBe(14)
  })
  it('operator overrides for tag, lead source and event source url win', () => {
    const c = paidTrialConfigFromBlocks([{ ...sellable(), tag: 'x-tag', lead_source: 'tiktok', event_source_url: 'https://x.test/t' }], 'stillorgan')
    expect(c).toMatchObject({ tag: 'x-tag', leadSource: 'tiktok', eventSourceUrl: 'https://x.test/t' })
  })
})

describe('formatTrialPrice', () => {
  it.each([[3900, '€39'], [3950, '€39.50'], [0, '€0'], [null, '€0']])('%s → %s', (c, s) => expect(formatTrialPrice(c)).toBe(s))
  it('names a non-euro currency', () => expect(formatTrialPrice(1000, 'GBP')).toBe('GBP 10'))
})

describe('trialTicks', () => {
  it('drops blanks and non-strings, trims, caps at six', () => {
    expect(trialTicks({ ticks: [' a ', '', 7, 'b', 'c', 'd', 'e', 'f', 'g'] })).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(trialTicks({ ticks: 'nope' })).toEqual([])
    expect(trialTicks(null)).toEqual([])
  })
})

describe('trialPurchasePublicState', () => {
  it('granted only when the plan is on the account; paid is money in, grant in flight', () => {
    expect(trialPurchasePublicState({ status: 'granted', payment_status: 'paid' })).toBe('granted')
    expect(trialPurchasePublicState({ status: 'queued', payment_status: 'paid' })).toBe('paid')
    expect(trialPurchasePublicState({ status: 'needs_review', payment_status: 'paid' })).toBe('paid')
    expect(trialPurchasePublicState({ status: 'awaiting_payment', payment_status: 'pending' })).toBe('pending')
    expect(trialPurchasePublicState({ status: 'payment_failed', payment_status: 'failed' })).toBe('failed')
    expect(trialPurchasePublicState({ status: 'awaiting_payment', payment_status: 'expired' })).toBe('failed')
    expect(trialPurchasePublicState(null)).toBe('notfound')
  })
})
