// PAGES.1 (M9) — the page-mode save body the editor sends, built through the
// same helpers LandingPageSettingsForm uses (storedChrome, termsForSave,
// blocksOrDefault), must parse with the PUT route's own schema for a
// backfill-shaped row. Every client test mocks fetch, so without this a drift
// between the form and landingPageUpdateSchema (the Task 15 logo_alt 120/200
// bug) surfaces only as a 400 in production.

import { describe, it, expect } from 'vitest'
import { landingPageUpdateSchema } from '@/lib/landing-page-schemas'
import { blocksOrDefault, newBlockOfType } from '@/lib/landing-page-blocks'
import { splitOfferBlock } from '@/lib/landing-page-offers'
import { pageBlocksToStore } from '@/lib/landing-pages'
import { storedChrome, termsForSave } from './page-save'

// What mig 792 copied over from landing_page_settings: every chrome key the
// legacy row held, the server-owned was_live, the terms copy, and a logo alt
// at the legacy table's 200-character limit.
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

// The form's handleSave + savePage, minus the fetch.
function saveBody({ page, title = page.title, logoAlt = page.chrome?.logo_alt || '', terms = page.chrome?.un1t_terms || {} }) {
  const chromeFields = {
    logo_url: (page.chrome?.logo_url || '').trim() || null,
    logo_alt: logoAlt.trim() || null,
    logo_width_px: page.chrome?.logo_width_px ?? null,
    show_instagram_feed: Boolean(page.chrome?.show_instagram_feed),
  }
  const chrome = { ...storedChrome(page.chrome), ...chromeFields }
  if (page.kind === 'studio') chrome.un1t_terms = termsForSave(terms)
  return { title: title.trim(), blocks: blocksOrDefault(page.blocks), chrome }
}

// The page half of a paid_trial block, as the editor holds it.
const OFFER_BLOCK = splitOfferBlock({ ...newBlockOfType('paid_trial', { brand: 'UN1T' }), id: 'b-offer' }).page

const campaign = {
  id: 'p-1', kind: 'campaign', scope: 'all', offer_type: 'paid_trial', title: '14 Day Reset',
  blocks: [OFFER_BLOCK, { ...newBlockOfType('stats', { brand: 'UN1T' }), id: 'b-stats' }],
  chrome: BACKFILLED_CHROME,
}
const studio = { ...campaign, kind: 'studio', scope: 'one', title: 'UN1T Hatch Street' }

describe('the page-mode save body vs landingPageUpdateSchema', () => {
  it('a backfill-shaped campaign page, saved unchanged, parses (was_live and un1t_terms included)', () => {
    const body = saveBody({ page: campaign })
    // was_live never leaves the form (storedChrome drops it); the server keeps the stored value.
    expect(body.chrome).not.toHaveProperty('was_live')
    expect(body.chrome.logo_alt).toHaveLength(200)
    const parsed = landingPageUpdateSchema.safeParse(body)
    expect(parsed.error?.issues ?? null).toBeNull()
    expect(parsed.success).toBe(true)
  })

  it('a backfill-shaped studio page with its terms copy parses (blank terms go as null)', () => {
    const body = saveBody({ page: studio, terms: { terms_label: '  I accept  ', legal_unavailable_message: '' } })
    expect(body.chrome.un1t_terms).toEqual({
      terms_label: 'I accept', terms_link_label: null, waiver_link_label: null,
      terms_required_message: null, legal_unavailable_message: null,
    })
    expect(landingPageUpdateSchema.safeParse(body).success).toBe(true)
  })

  it('the stored chrome with was_live and every key still parses when sent whole', () => {
    expect(landingPageUpdateSchema.safeParse({ chrome: BACKFILLED_CHROME }).success).toBe(true)
  })

  it('a studio key on blocks[0] passes the schema and is stripped by pageBlocksToStore, never stored', () => {
    const body = saveBody({ page: campaign })
    body.blocks[0] = { ...body.blocks[0], plan_code: 'P', membership_id: 'm-1', un1t_product_id: 'u-1', tag: 'leak' }
    const parsed = landingPageUpdateSchema.safeParse(body)
    expect(parsed.success).toBe(true)
    const stored = pageBlocksToStore(campaign, parsed.data.blocks)
    expect(stored.ok).toBe(true)
    for (const key of ['plan_code', 'membership_id', 'un1t_product_id', 'tag']) expect(stored.blocks[0]).not.toHaveProperty(key)
    expect(stored.blocks[1]).toEqual(body.blocks[1])
  })
})
