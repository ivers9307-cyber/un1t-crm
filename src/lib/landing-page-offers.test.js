import { describe, it, expect } from 'vitest'
import { splitOfferBlock, mergeOfferBlock, offerConfigured, STUDIO_OFFER_KEYS, defaultAttribution, offerTypeOfBlock, studioOfferSchema, attributionSchema } from './landing-page-offers.js'

const CAMPAIGN = { id: 'b1', type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+', trial_membership_id: 'm', trial_plan_code: 'p', tag: 'stillorgan-50plus', lead_source: 'meta_50plus', event_source_url: '', heading: 'A free trial', show_sections: ['stats'], video_url: 'https://x/v.mp4' }

describe('landing-page-offers', () => {
  it('splits a campaign_funnel block into its page half and studio half, dropping the campaign key and sections', () => {
    const { page, studio } = splitOfferBlock(CAMPAIGN)
    expect(page).toEqual({ id: 'b1', type: 'campaign_funnel', heading: 'A free trial', video_url: 'https://x/v.mp4' })
    expect(studio.offer).toEqual({ class_keywords: '50+', trial_membership_id: 'm', trial_plan_code: 'p' })
    expect(studio.attribution).toEqual({ tag: 'stillorgan-50plus', lead_source: 'meta_50plus' })
  })
  it('merges back to a block the existing config functions read', () => {
    const { page, studio } = splitOfferBlock(CAMPAIGN)
    const merged = mergeOfferBlock(page, studio)
    expect(merged.trial_plan_code).toBe('p')
    expect(merged.tag).toBe('stillorgan-50plus')
    expect(mergeOfferBlock(null, studio)).toBeNull()
  })
  it('judges readiness per block type', () => {
    const { page, studio } = splitOfferBlock(CAMPAIGN)
    expect(offerConfigured('campaign_funnel', mergeOfferBlock(page, studio), { landingPath: 'stillorgan' })).toBe(true)
    expect(offerConfigured('campaign_funnel', mergeOfferBlock(page, { offer: { ...studio.offer, class_keywords: '' }, attribution: {} }), { landingPath: 'stillorgan' })).toBe(false)
    expect(offerConfigured('paid_trial', { type: 'paid_trial', membership_id: 'm', plan_code: 'p', price_cents: 3900 }, { landingPath: 'stillorgan' })).toBe(true)
    expect(offerConfigured('paid_trial', { type: 'paid_trial', membership_id: '', plan_code: '', price_cents: 3900 }, { landingPath: 'stillorgan' })).toBe(false)
    expect(offerConfigured('corp_promo', { type: 'corp_promo', promo_key: 'no-such-promo' }, {})).toBe(false)
    expect(offerConfigured('class_funnel', { type: 'class_funnel', timetable: 'Mon 07:00 S&C' }, { landingPath: 'hatch-street' })).toBe(true)
  })
  it('names every studio key the migration strips (pinned by the migration test)', () => {
    expect(STUDIO_OFFER_KEYS.corp_promo).toEqual(['promo_key'])
    expect(offerTypeOfBlock('campaign_funnel')).toBe('one_class')
    expect(offerTypeOfBlock('hero')).toBeNull()
    expect(defaultAttribution({ publicPath: 'stillorgan', slug: 'january' })).toEqual({ tag: 'stillorgan-january', lead_source: 'meta_january' })
  })
  it('refuses an unknown key and a price out of range on the studio half', () => {
    expect(studioOfferSchema('paid_trial').safeParse({ membership_id: 'm', plan_code: 'p', price_cents: 3900, extra: 1 }).success).toBe(false)
    expect(studioOfferSchema('paid_trial').safeParse({ price_cents: 60_000 }).success).toBe(false)
    expect(studioOfferSchema('corp_promo').safeParse({ promo_key: 'hatch-3-free' }).success).toBe(true)
  })
  it('refuses an unknown attribution key rather than storing it', () => {
    expect(attributionSchema.safeParse({ tag: 't', lead_source: 'l' }).success).toBe(true)
    expect(attributionSchema.safeParse({ tag: 't', campaign: 'x' }).success).toBe(false)
  })
})
