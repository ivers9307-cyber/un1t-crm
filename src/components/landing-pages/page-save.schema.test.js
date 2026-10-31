// PAGES.1 (M9) — the save bodies the editor sends, built by the very builders
// LandingPageSettingsForm and StudioOfferRow call (pageSaveBody,
// studioRowSaveBody), must parse with the routes' own schemas for a
// backfill-shaped row. Every client test mocks fetch, so without this a drift
// between the form and landingPageUpdateSchema / landingPageStudioSchema (the
// Task 15 logo_alt 120/200 bug) surfaces only as a 400 in production.

import { describe, it, expect } from 'vitest'
import { landingPageUpdateSchema, landingPageStudioSchema } from '@/lib/landing-page-schemas'
import { blocksOrDefault, newBlockOfType } from '@/lib/landing-page-blocks'
import { splitOfferBlock, studioOfferSchema, STUDIO_OFFER_KEYS } from '@/lib/landing-page-offers'
import { pageBlocksToStore } from '@/lib/landing-pages'
import { fieldsFromOffer, offerFromFields } from './studio-offer-fields'
import { pageSaveBody, studioRowSaveBody } from './page-save'

// What mig 792 copied over to a studio page: every chrome key the old
// per-studio row held, the server-owned was_live, the terms copy, and a logo
// alt at that table's 200-character limit.
const BACKFILLED_CHROME = {
  logo_url: 'https://cdn.example/logo.png',
  logo_alt: 'a'.repeat(200),
  logo_width_px: 180,
  tone: 'dark',
  noindex: false,
  meta_title: 'UN1T Hatch Street',
  meta_description: 'Strength and conditioning in Dublin 2.',
  show_instagram_feed: true,
  chooser_label: 'Hatch Street',
  chooser_cta_text: 'Book',
  chooser_image_url: 'https://cdn.example/chooser.jpg',
  un1t_terms: { terms_label: 'I agree to the {terms}', waiver_link_label: null },
  was_live: true,
}

// The form's state for a page as it opens (what LandingPageSettingsForm seeds).
function openedState(page) {
  return {
    page,
    title: page.title,
    blocks: blocksOrDefault(page.blocks),
    logoUrl: page.chrome?.logo_url || '',
    logoAlt: page.chrome?.logo_alt || '',
    logoWidthPx: String(page.chrome?.logo_width_px || ''),
    showInstagramFeed: page.chrome?.show_instagram_feed !== false,
    terms: { ...(page.chrome?.un1t_terms || {}) },
  }
}

// The page half of a paid_trial block, as the editor holds it.
const OFFER_BLOCK = splitOfferBlock({ ...newBlockOfType('paid_trial', { brand: 'UN1T' }), id: 'b-offer' }).page
const STATS = { ...newBlockOfType('stats', { brand: 'UN1T' }), id: 'b-stats' }

const campaign = {
  id: 'p-1', kind: 'campaign', scope: 'all', offer_type: 'paid_trial', title: '14 Day Reset',
  blocks: [OFFER_BLOCK, STATS],
  chrome: BACKFILLED_CHROME,
}
// mig 792 kept a studio's own block order: its paid_trial block is the last one.
const studio = { ...campaign, kind: 'studio', scope: 'one', title: 'UN1T Hatch Street', blocks: [STATS, OFFER_BLOCK] }

describe('the page save body (pageSaveBody) vs landingPageUpdateSchema', () => {
  it('a backfill-shaped campaign page, saved unchanged, parses (was_live never sent)', () => {
    const body = pageSaveBody(openedState(campaign))
    expect(body.chrome).not.toHaveProperty('was_live')
    expect(body.chrome.logo_alt).toHaveLength(200)
    expect(body.chrome.logo_width_px).toBe(180)
    const parsed = landingPageUpdateSchema.safeParse(body)
    expect(parsed.error?.issues ?? null).toBeNull()
    expect(parsed.success).toBe(true)
  })

  it('a backfill-shaped studio page with its terms copy parses (blank terms go as null)', () => {
    const body = pageSaveBody({ ...openedState(studio), terms: { terms_label: '  I accept  ', legal_unavailable_message: '' } })
    expect(body.chrome.un1t_terms).toEqual({
      terms_label: 'I accept', terms_link_label: null, waiver_link_label: null,
      terms_required_message: null, legal_unavailable_message: null,
    })
    expect(landingPageUpdateSchema.safeParse(body).success).toBe(true)
  })

  it('a studio page whose offer block is last saves in its own order', () => {
    const parsed = landingPageUpdateSchema.safeParse(pageSaveBody(openedState(studio)))
    expect(parsed.success).toBe(true)
    const stored = pageBlocksToStore(studio, parsed.data.blocks)
    expect(stored.ok).toBe(true)
    expect(stored.blocks.map((b) => b.id)).toEqual(['b-stats', 'b-offer'])
  })

  it('the logo width is clamped and a blank one goes as null', () => {
    expect(pageSaveBody({ ...openedState(campaign), logoWidthPx: '9000' }).chrome.logo_width_px).toBe(600)
    expect(pageSaveBody({ ...openedState(campaign), logoWidthPx: '' }).chrome.logo_width_px).toBeNull()
  })

  it('the stored chrome with was_live and every key still parses when sent whole', () => {
    expect(landingPageUpdateSchema.safeParse({ chrome: BACKFILLED_CHROME }).success).toBe(true)
  })

  it('a studio key on the offer block passes the schema and is stripped by pageBlocksToStore, never stored', () => {
    const body = pageSaveBody(openedState(campaign))
    body.blocks[0] = { ...body.blocks[0], plan_code: 'P', membership_id: 'm-1', un1t_product_id: 'u-1', tag: 'leak' }
    const parsed = landingPageUpdateSchema.safeParse(body)
    expect(parsed.success).toBe(true)
    const stored = pageBlocksToStore(campaign, parsed.data.blocks)
    expect(stored.ok).toBe(true)
    for (const key of ['plan_code', 'membership_id', 'un1t_product_id', 'tag']) expect(stored.blocks[0]).not.toHaveProperty(key)
    expect(stored.blocks[1]).toEqual(body.blocks[1])
  })
})

describe('the studio row save body (studioRowSaveBody) vs landingPageStudioSchema', () => {
  const ROW_OFFERS = {
    paid_trial: { membership_id: 'm-1', plan_code: 'P', price_cents: 3950, currency: 'EUR', duration_days: 14, product_name: 'Reset', studio_label: 'Hatch' },
    class_funnel: { trial_membership_id: 'tm', trial_plan_code: 'tp', price_cents: 0, consult_slug: 'consult', timetable: 'Mon 09:00 Strength', timetable_start_date: '2026-11-02', min_notice_hours: 12 },
    campaign_funnel: { trial_membership_id: 'tm', trial_plan_code: 'tp', class_keywords: '50+' },
    corp_promo: { promo_key: 'hatch-3-free' },
  }

  for (const [blockType, offer] of Object.entries(ROW_OFFERS)) {
    it(`a ${blockType} row opened and saved unchanged parses, offer included`, () => {
      const stored = { tag: 'hatch-trial', lead_source: 'meta_trial', event_source_url: 'https://www.un1tdublin.com/trial' }
      const body = studioRowSaveBody({
        enabled: true,
        offer: offerFromFields(blockType, fieldsFromOffer(blockType, offer)),
        attribution: { tag: ' hatch-trial ', lead_source: '' },
        storedAttribution: stored,
      })
      expect(body.attribution).toEqual({ tag: 'hatch-trial', event_source_url: 'https://www.un1tdublin.com/trial' })
      const parsed = landingPageStudioSchema.safeParse(body)
      expect(parsed.error?.issues ?? null).toBeNull()
      const offerParsed = studioOfferSchema(blockType).safeParse(parsed.data.offer)
      expect(offerParsed.error?.issues ?? null).toBeNull()
      for (const key of Object.keys(parsed.data.offer)) expect(STUDIO_OFFER_KEYS[blockType]).toContain(key)
    })
  }

  it('a row with nothing set sends an empty offer and attribution', () => {
    const body = studioRowSaveBody({ enabled: false, offer: offerFromFields('paid_trial', {}), attribution: { tag: '', lead_source: '' }, storedAttribution: {} })
    expect(body).toEqual({ enabled: false, offer: {}, attribution: {} })
    expect(landingPageStudioSchema.safeParse(body).success).toBe(true)
  })
})
