// PAGES.1 — the seam between an offer block's PAGE half (words, media: stays
// on the landing_pages row) and its STUDIO half (plan ids, class keywords,
// price, attribution: lives on the landing_page_studios row). splitOfferBlock
// cuts one of today's offer blocks in two; mergeOfferBlock puts them back so
// the existing config functions (paidTrialConfigFromBlocks,
// campaignFunnelConfig, classFunnelConfigFromBlocks,
// manualTimetableConfigFromBlocks, resolveCorpPromo) keep reading one block.
//
// Pure, no IO, importable from the client bundle. STUDIO_OFFER_KEYS is pinned
// against the SQL that strips the same keys out of the stored blocks, so edit
// the two together. The design is
// docs/superpowers/specs/2026-10-30-landing-pages-editor-design.md.

import { z } from 'zod'
import { paidTrialConfigFromBlocks } from '@/lib/paid-trial'
import { campaignFunnelConfig } from '@/lib/campaign-funnel'
import { classFunnelConfigFromBlocks } from '@/lib/public-landing'
import { manualTimetableConfigFromBlocks } from '@/lib/manual-timetable'
import { resolveCorpPromo } from '@/lib/corp-promos'

export const OFFER_TYPES = Object.freeze(['paid_trial', 'class_funnel', 'one_class', 'promo_credits', 'none'])

/** The offer type an editor picks, to the block type it stores. */
export const OFFER_BLOCK_TYPE = Object.freeze({
  paid_trial: 'paid_trial',
  class_funnel: 'class_funnel',
  one_class: 'campaign_funnel',
  promo_credits: 'corp_promo',
})

/** The inverse of OFFER_BLOCK_TYPE: a block type to its offer type, or null for any other block. */
export function offerTypeOfBlock(blockType) {
  for (const [offerType, type] of Object.entries(OFFER_BLOCK_TYPE)) {
    if (type === blockType) return offerType
  }
  return null
}

export const ATTRIBUTION_KEYS = Object.freeze(['tag', 'lead_source', 'event_source_url'])

/** The keys that belong to the studio, by BLOCK type. */
export const STUDIO_OFFER_KEYS = Object.freeze({
  paid_trial: ['membership_id', 'plan_code', 'un1t_product_id', 'price_cents', 'currency', 'duration_days', 'product_name', 'studio_label'],
  class_funnel: ['trial_membership_id', 'trial_plan_code', 'price_cents', 'currency', 'consult_slug', 'timetable', 'timetable_start_date', 'min_notice_hours'],
  campaign_funnel: ['trial_membership_id', 'trial_plan_code', 'class_keywords'],
  corp_promo: ['promo_key'],
})

/** Keys a block used to carry that the page now owns itself (the page's slug replaces `campaign`). */
export const DROPPED_BLOCK_KEYS = Object.freeze({
  campaign_funnel: ['campaign', 'show_sections'],
})

/**
 * Cut an offer block in two. `page` keeps `id`, `type` and every key not named
 * in the three lists; `studio.offer` takes the block type's studio keys that
 * are present; `studio.attribution` takes the attribution keys that hold a
 * value (an empty string is no value).
 */
export function splitOfferBlock(block) {
  const b = block && typeof block === 'object' ? block : {}
  const offerKeys = STUDIO_OFFER_KEYS[b.type] || []
  const dropped = DROPPED_BLOCK_KEYS[b.type] || []
  const page = {}
  const offer = {}
  const attribution = {}
  for (const [key, value] of Object.entries(b)) {
    if (value === undefined) continue
    if (ATTRIBUTION_KEYS.includes(key)) {
      if (value !== '') attribution[key] = value
    } else if (offerKeys.includes(key)) {
      offer[key] = value
    } else if (!dropped.includes(key)) {
      page[key] = value
    }
  }
  return { page, studio: { offer, attribution } }
}

/** Put the halves back into the one block the config functions read; null when there is no page block. */
export function mergeOfferBlock(pageBlock, studioRow) {
  if (!pageBlock) return null
  return { ...pageBlock, ...(studioRow?.offer || {}), ...(studioRow?.attribution || {}) }
}

const text200 = z.string().max(200)
const priceCents = z.number().int().min(0).max(50_000)

const SCHEMA_SHAPES = {
  paid_trial: {
    membership_id: text200,
    plan_code: text200,
    un1t_product_id: text200,
    price_cents: priceCents,
    currency: text200,
    duration_days: z.number().int().min(1).max(365),
    product_name: text200,
    studio_label: text200,
  },
  class_funnel: {
    trial_membership_id: text200,
    trial_plan_code: text200,
    price_cents: priceCents,
    currency: text200,
    consult_slug: text200,
    timetable: z.string().max(4000),
    timetable_start_date: text200,
    min_notice_hours: z.number().min(0).max(168),
  },
  campaign_funnel: {
    trial_membership_id: text200,
    trial_plan_code: text200,
    class_keywords: text200,
  },
  corp_promo: {
    promo_key: z.string().max(64),
  },
}

/** The validator for a studio row's `offer`, by block type: strict, every key optional. */
export function studioOfferSchema(blockType) {
  const shape = SCHEMA_SHAPES[blockType] || {}
  return z.object(Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()]))).strict()
}

export const attributionSchema = z.object({
  tag: z.string().max(80).optional(),
  lead_source: z.string().max(80).optional(),
  event_source_url: z.string().url().max(500).optional(),
}).strict()

/** What a new page starts with: a tag and lead source named for the studio path and the page slug. */
export function defaultAttribution({ publicPath, slug }) {
  return { tag: `${publicPath}-${slug}`, lead_source: `meta_${slug}` }
}

/**
 * Is this offer ready to take a customer? Judged by the same functions the
 * public routes use, on the merged block.
 */
export function offerConfigured(blockType, mergedBlock, { landingPath, product = null } = {}) {
  if (blockType === 'paid_trial') {
    return paidTrialConfigFromBlocks([mergedBlock], landingPath, { product }) !== null
  }
  if (blockType === 'campaign_funnel') {
    const cfg = campaignFunnelConfig(mergedBlock, { landingPath })
    return cfg.configured && cfg.allowKeywords.length > 0
  }
  if (blockType === 'class_funnel') {
    return classFunnelConfigFromBlocks([mergedBlock], landingPath).trialMembershipId !== null
      || manualTimetableConfigFromBlocks([mergedBlock]) !== null
  }
  if (blockType === 'corp_promo') {
    return resolveCorpPromo(mergedBlock?.promo_key) !== null
  }
  return false
}
