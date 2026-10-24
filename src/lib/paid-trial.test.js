import { describe, it, expect } from 'vitest'
import { paidTrialConfigFromBlocks, paidTrialCopyFromBlock, PAID_TRIAL_PENDING_BODY, formatTrialPrice, trialTicks, trialPurchasePublicState } from './paid-trial'
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
    expect(c).toMatchObject({ priceCents: 3900, currency: 'EUR', durationDays: 14, membershipId: 'm1', planCode: 'p1', productName: 'The 14 Day Reset' })
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

describe('paidTrialConfigFromBlocks, un1t.online shape (TRIALSTUDIO.2)', () => {
  const blocks = [{ type: 'paid_trial', un1t_product_id: 'p-1', product_name: 'The UN1T Trial', duration_days: 14 }]
  it('a un1t block is sellable only with a mirrored active product above €0', () => {
    expect(paidTrialConfigFromBlocks(blocks, 'hatch-street')).toBeNull()
    const cfg = paidTrialConfigFromBlocks(blocks, 'hatch-street', { product: { un1t_id: 'p-1', status: 'active', price_cents: 3900, currency: 'eur' } })
    expect(cfg).toMatchObject({ provider: 'un1t_online', un1tProductId: 'p-1', priceCents: 3900, currency: 'EUR', membershipId: null, planCode: null, productName: 'The UN1T Trial', tag: 'hatch-street-trial' })
    expect(cfg.block).toBe(blocks[0])
    expect(paidTrialConfigFromBlocks(blocks, 'hatch-street', { product: { un1t_id: 'p-1', status: 'active', price_cents: 0 } })).toBeNull()
  })
  it('refuses a product that is inactive, for another id, or missing a price', () => {
    const ok = { un1t_id: 'p-1', status: 'active', price_cents: 3900 }
    expect(paidTrialConfigFromBlocks(blocks, 'hatch-street', { product: { ...ok, status: 'archived' } })).toBeNull()
    expect(paidTrialConfigFromBlocks(blocks, 'hatch-street', { product: { ...ok, un1t_id: 'p-2' } })).toBeNull()
    expect(paidTrialConfigFromBlocks(blocks, 'hatch-street', { product: { ...ok, price_cents: null } })).toBeNull()
    expect(paidTrialConfigFromBlocks(blocks, 'hatch-street', { product: ok }).currency).toBe('EUR')
  })
  it('a Glofox block ignores the product argument and keeps its typed price', () => {
    const cfg = paidTrialConfigFromBlocks([sellable()], 'stillorgan', { product: { un1t_id: 'p-1', status: 'active', price_cents: 100, currency: 'gbp' } })
    expect(cfg).toMatchObject({ provider: 'glofox', un1tProductId: null, priceCents: 3900, currency: 'EUR', membershipId: 'm1', planCode: 'p1' })
  })
  it('carries the studio label and the help / gate copy, defaulted from the block', () => {
    const cfg = paidTrialConfigFromBlocks([sellable()], 'stillorgan')
    expect(cfg.studioLabel).toBe('')
    expect(cfg.helpCtaLabel).toBe('I need help')
    expect(cfg.helpSentText).toBe('Thanks. The team will be in touch shortly.')
    expect(cfg.trialUsedText).toContain('already had a trial with us at Stillorgan')
    expect(cfg.activeMemberText).toContain('active membership at Hatch Street')
    const custom = paidTrialConfigFromBlocks([{ ...sellable(), studio_label: ' Stillorgan ', help_cta_label: 'Help' }], 'stillorgan')
    expect(custom).toMatchObject({ studioLabel: 'Stillorgan', helpCtaLabel: 'Help' })
  })
  it('a stored block that predates the new fields (or blanks them) is served the design copy', () => {
    const raw = { type: 'paid_trial', price_cents: 3900, membership_id: 'm1', plan_code: 'p1' }
    const expected = {
      studioLabel: '',
      trialUsedText: "It looks like you've already had a trial with us at Stillorgan, so the 14 Day Reset can't be redeemed on this account. If that's not right, or you'd like to talk about your options, tap I need help and the team will be in touch.",
      activeMemberText: "It looks like you already have an active membership at UN1T Hatch Street, which already covers your classes. If that's not right, tap I need help and the team will be in touch.",
      helpCtaLabel: 'I need help',
      helpSentText: 'Thanks. The team will be in touch shortly.',
      pendingBody: "Thanks, your payment is being confirmed. un1t.online will email your receipt and we'll have your trial on your account shortly.",
    }
    expect(paidTrialConfigFromBlocks([raw], 'stillorgan')).toMatchObject(expected)
    const blanked = { ...raw, studio_label: '  ', trial_used_text: '', active_member_text: ' ', help_cta_label: '', help_sent_text: null, pending_body: ' ' }
    expect(paidTrialConfigFromBlocks([blanked], 'stillorgan')).toMatchObject(expected)
    // The same words for a block that is not for sale, or no block at all.
    expect(paidTrialCopyFromBlock({ type: 'paid_trial' })).toEqual(expected)
    expect(paidTrialCopyFromBlock(null)).toEqual(expected)
  })
  it('pendingBody is the block\'s own when set', () => {
    const config = paidTrialConfigFromBlocks([{ ...sellable(), pending_body: ' Hang tight. ' }], 'stillorgan')
    expect(config.pendingBody).toBe('Hang tight.')
    expect(PAID_TRIAL_PENDING_BODY).toMatch(/un1t\.online will email your receipt/)
  })
  it('the default block ships the new fields; the active-member copy names the brand when given one', () => {
    expect(newBlockOfType('paid_trial')).toMatchObject({ studio_label: '', un1t_product_id: '', help_cta_label: 'I need help', help_sent_text: 'Thanks. The team will be in touch shortly.' })
    expect(newBlockOfType('paid_trial', { brand: 'UN1T' }).active_member_text).toBe("It looks like you already have an active membership at UN1T Hatch Street, which already covers your classes. If that's not right, tap I need help and the team will be in touch.")
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
  it('expired and help rows (TRIALSTUDIO.2)', () => {
    expect(trialPurchasePublicState({ status: 'expired' })).toBe('expired')
    expect(trialPurchasePublicState({ status: 'help_requested' })).toBe('help')
    expect(trialPurchasePublicState({ status: 'handled' })).toBe('help')
    expect(trialPurchasePublicState({ status: 'awaiting_payment', payment_provider: 'un1t_online' })).toBe('pending')
    expect(trialPurchasePublicState({ status: 'awaiting_payment', payment_provider: 'un1t_online', payment_status: 'expired' })).toBe('pending')
  })
})
