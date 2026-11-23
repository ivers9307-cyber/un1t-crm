import { describe, it, expect } from 'vitest'
import { forLine, pageEntry, storeEntry, rankPages, dateTimeLabel, dayLabel } from './offer-view'

const ZONE = 'Europe/Dublin'

describe('pageEntry', () => {
  it('paid trial: price from the merged block, no end date', () => {
    const e = pageEntry({
      page: { title: '14 Day Reset', offer_type: 'paid_trial', chrome: {} },
      mergedOffer: { type: 'paid_trial', price_cents: 3900, currency: 'EUR', duration_days: 14, ticks: ['14 days of unlimited classes'] },
      promo: null, zone: ZONE, url: 'https://x.test/trial', withOffer: true,
    })
    expect(e).toMatchObject({ title: '14 Day Reset', kind: 'paid_trial', price_label: '€39', ends_label: null, url: 'https://x.test/trial', priority: 'normal' })
    expect(e.for).toBe('Someone new who wants to try the studio.')
    expect(e.summary).toContain('14 days')
  })

  it('promo: Free, the class count in the summary, the window end as ends_label', () => {
    const e = pageEntry({
      page: { title: 'Open Week', offer_type: 'promo_credits', chrome: {} },
      mergedOffer: { type: 'corp_promo', promo_key: 'secret-key', tag: 'secret-tag' },
      promo: { key: 'secret-key', kind: 'open_week', platform: 'glofox', credits: 5, maxClasses: 5, windowStartsOn: '2026-11-23', windowEndsOn: '2026-11-29', live: true },
      zone: ZONE, url: 'https://x.test/openweek', withOffer: true, studioName: 'UN1T Stillorgan',
    })
    expect(e.price_label).toBe('Free')
    expect(e.summary).toMatch(/5 free classes/)
    expect(e.summary).not.toMatch(/\{/)
    expect(e.ends_label).toBe('Sun 29 Nov')
    expect(JSON.stringify(e)).not.toContain('secret')
  })

  it('a plain promo counts its credits and has no end date', () => {
    const e = pageEntry({
      page: { title: 'Corporate promo', offer_type: 'promo_credits', chrome: {} },
      mergedOffer: { type: 'corp_promo', promo_key: 'k' },
      promo: { key: 'k', kind: 'promo', platform: 'un1t_online', credits: 3, live: true, windowEndsOn: null },
      zone: ZONE, url: 'https://x.test/corp', withOffer: true, studioName: 'UN1T Hatch Street',
    })
    expect(e.summary).toMatch(/3 free classes/)
    expect(e.ends_label).toBeNull()
  })

  it('one class page stores no price: price_label null', () => {
    const e = pageEntry({
      page: { title: 'The 50+ Club', offer_type: 'one_class', chrome: {} },
      mergedOffer: { type: 'campaign_funnel', subhead: 'Strength and mobility for the over-50s.', trial_plan_code: 'secret-plan' },
      promo: null, zone: ZONE, url: 'https://x.test/50plus', withOffer: true,
    })
    expect(e.price_label).toBeNull()
    expect(e.summary).toBe('Strength and mobility for the over-50s.')
    expect(e.for).toBe('The 50+ Club: Strength and mobility for the over-50s.')
    expect(JSON.stringify(e)).not.toContain('secret')
  })

  it('withOffer false: title, summary and url only', () => {
    const e = pageEntry({
      page: { title: 'UN1T Stillorgan', offer_type: 'paid_trial', chrome: { meta_description: 'Our Stillorgan studio.' } },
      mergedOffer: { type: 'paid_trial', price_cents: 3900 }, promo: null, zone: ZONE, url: 'https://x.test/stillorgan', withOffer: false,
    })
    expect(e).toMatchObject({ title: 'UN1T Stillorgan', price_label: null, ends_label: null, summary: 'Our Stillorgan studio.', url: 'https://x.test/stillorgan' })
  })

  it('a summary is one line of at most 200 characters', () => {
    const e = pageEntry({
      page: { title: 'T', offer_type: 'one_class', chrome: {} },
      mergedOffer: { type: 'campaign_funnel', subhead: `line one\nline two ${'x'.repeat(400)}` },
      promo: null, zone: ZONE, url: 'u', withOffer: true,
    })
    expect(e.summary).not.toContain('\n')
    expect(e.summary.length).toBeLessThanOrEqual(200)
  })
})

describe('forLine', () => {
  it('the editor line wins; blank or spaces falls back to the default', () => {
    expect(forLine({ offer_type: 'paid_trial', title: 'T', chrome: { mia_note: 'People over 50.' } }, null)).toBe('People over 50.')
    expect(forLine({ offer_type: 'paid_trial', title: 'T', chrome: { mia_note: '   ' } }, null)).toBe('Someone new who wants to try the studio.')
    expect(forLine({ offer_type: 'paid_trial', title: 'T', chrome: null }, null)).toBe('Someone new who wants to try the studio.')
    expect(forLine({ offer_type: 'sale', title: 'T', chrome: {} }, null)).toBe('Anyone buying a pack, a membership or a gift.')
    expect(forLine({ offer_type: 'promo_credits', title: 'New Start', chrome: {} }, 'Three free classes for new members.')).toBe('New Start: Three free classes for new members.')
    expect(forLine({ offer_type: 'none', title: 'About us', chrome: {} }, null)).toBe('About us')
  })
})

describe('rankPages', () => {
  const item = (title, { priority, endsOn = null, withOffer = true } = {}) => ({
    entry: { title, priority: 'normal' }, page: { title, chrome: priority ? { mia_priority: priority } : {} }, endsOn, withOffer,
  })
  const ranked = (items) => rankPages(items).map((e) => [e.title, e.priority])

  it('a time-limited open offer leads the open-ended trial', () => {
    const trial = item('14 Day Reset')
    const week = item('Open Week', { endsOn: '2026-11-29' })
    const home = item('UN1T Stillorgan', { withOffer: false })
    expect(ranked([trial, home, week])).toEqual([['Open Week', 'lead'], ['14 Day Reset', 'normal'], ['UN1T Stillorgan', 'normal']])
    expect(ranked([trial, home])).toEqual([['14 Day Reset', 'lead'], ['UN1T Stillorgan', 'normal']])
  })

  it('the operator override beats the automatic rule', () => {
    expect(ranked([item('Corporate promo', { priority: 'ask_only' }), item('Open Week', { endsOn: '2026-11-29' }), item('14 Day Reset', { priority: 'lead' })]))
      .toEqual([['14 Day Reset', 'lead'], ['Open Week', 'normal'], ['Corporate promo', 'only_if_asked']])
  })

  it('two time-limited offers, the sooner end first; two operator leads both lead', () => {
    expect(ranked([item('B', { endsOn: '2026-12-05' }), item('A', { endsOn: '2026-11-29' })])).toEqual([['A', 'lead'], ['B', 'normal']])
    expect(ranked([item('Z', { priority: 'lead' }), item('A', { priority: 'lead' })])).toEqual([['A', 'lead'], ['Z', 'lead']])
  })

  it('no page with an offer means no lead; an empty list is an empty list', () => {
    expect(ranked([item('Home', { withOffer: false }), item('Corp', { priority: 'ask_only' })])).toEqual([['Home', 'normal'], ['Corp', 'only_if_asked']])
    expect(rankPages([])).toEqual([])
    expect(rankPages(undefined)).toEqual([])
  })
})

describe('storeEntry', () => {
  const offer = { id: 'offer-id-1', un1t_product_id: 'prod-9', name: '20 Class Pack', category: 'class_pack', bonus_headline: '+5 free classes', price_cents: 38000, currency: 'EUR', ends_at: '2026-11-30T23:59:59Z', starts_at: null, stock_limit: 50 }
  const now = new Date('2026-11-23T12:00:00Z')

  it('labels in the studio zone, limited and sold out as flags, no number', () => {
    const e = storeEntry({ offer, stock: { limit: 50, sold: 50, held: 0, left: 0, state: 'sold_out' }, zone: ZONE, url: 'https://x.test/offers/stillorgan/20-class-pack', now })
    expect(e).toEqual({ name: '20 Class Pack', category: 'class_pack', bonus: '+5 free classes', price_label: '€380', ends_label: 'Mon 30 Nov, 23:59', opens_label: null, limited: true, sold_out: true, url: 'https://x.test/offers/stillorgan/20-class-pack' })
  })

  it('not yet open carries opens_label; stock null means not sold out; no limit means not limited', () => {
    const e = storeEntry({ offer: { ...offer, starts_at: '2026-11-27T00:00:00Z', stock_limit: null, bonus_headline: '' }, stock: null, zone: ZONE, url: 'u', now })
    expect(e.opens_label).toBe('Fri 27 Nov, 00:00')
    expect(e).toMatchObject({ limited: false, sold_out: false, bonus: null })
    const open = storeEntry({ offer: { ...offer, starts_at: '2026-11-01T00:00:00Z', ends_at: null }, stock: null, zone: ZONE, url: 'u', now })
    expect(open).toMatchObject({ opens_label: null, ends_label: null, limited: true, sold_out: false })
  })

  it('an end date is told on the studio clock, not UTC', () => {
    const e = storeEntry({ offer: { ...offer, ends_at: '2026-07-31T22:59:59Z' }, stock: null, zone: ZONE, url: 'u', now })
    expect(e.ends_label).toBe('Fri 31 Jul, 23:59')
  })
})

describe('labels', () => {
  it('dateTimeLabel and dayLabel', () => {
    expect(dateTimeLabel('2026-11-30T23:59:59Z', ZONE)).toBe('Mon 30 Nov, 23:59')
    expect(dayLabel('2026-11-29')).toBe('Sun 29 Nov')
  })
})
