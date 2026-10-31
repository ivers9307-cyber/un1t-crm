// PAGES.1 — the request bodies of the landing pages API (/api/landing-pages*).
// A page is a landing_pages row plus its landing_page_studios rows (mig 792);
// the rules live in src/lib/landing-pages.js, which re-exports
// LANDING_PAGE_PUBLISH_STATES as PAGE_PUBLISH_STATES.
//
// Its own module, not schemas.js: these import landing-page-offers and
// landing-page-blocks, and schemas.js is imported by client components that
// must not carry them.

import { z } from 'zod'
import { uuidLike } from './schemas'
import { OFFER_TYPES, attributionSchema } from './landing-page-offers'
import { BlocksArraySchema } from './landing-page-blocks'
import { REDIRECT_PATH_RE } from './page-slug'

export const LANDING_PAGE_PUBLISH_STATES = Object.freeze(['draft', 'live', 'coming_soon', 'retired'])

const pageTitle = z.string().trim().min(1).max(120)
const pageSlug = z.string().trim().min(2).max(40)

// A studio page is never created by hand: one exists per studio (mig 792's
// backfill, and a new studio's creation hook).
export const landingPageCreateSchema = z.object({
  title: pageTitle,
  slug: pageSlug,
  kind: z.literal('campaign'),
  scope: z.enum(['one', 'all']),
  primary_location_id: uuidLike.nullable().optional(),
  offer_type: z.enum(OFFER_TYPES),
  start_from_page_id: uuidLike.nullable().optional(),
}).strict()

const termsText = z.string().max(400).nullable()

// `was_live` is server-owned: the update route keeps the stored value and the
// publish route sets it when a page goes live.
export const landingPageChromeSchema = z.object({
  logo_url: z.string().url().nullable(),
  // 200, the legacy table's limit: mig 792 copied its alt text over as is.
  logo_alt: z.string().max(200).nullable(),
  logo_width_px: z.number().int().min(40).max(600).nullable(),
  tone: z.enum(['light', 'dark']),
  noindex: z.boolean(),
  meta_title: z.string().max(120).nullable(),
  meta_description: z.string().max(300).nullable(),
  show_instagram_feed: z.boolean(),
  chooser_label: z.string().trim().max(200).nullable(),
  chooser_cta_text: z.string().trim().max(60).nullable(),
  chooser_image_url: z.string().url().nullable(),
  un1t_terms: z.object({
    terms_label: termsText,
    terms_link_label: termsText,
    waiver_link_label: termsText,
    terms_required_message: termsText,
    legal_unavailable_message: termsText,
  }).strict().partial(),
  was_live: z.boolean(),
}).strict().partial()

// kind, scope, primary_location_id and offer_type are not updatable.
export const landingPageUpdateSchema = z.object({
  title: pageTitle.optional(),
  slug: pageSlug.optional(),
  blocks: BlocksArraySchema.optional(),
  chrome: landingPageChromeSchema.optional(),
}).strict()

// `offer` is re-parsed by the route with studioOfferSchema for the page's type.
export const landingPageStudioSchema = z.object({
  enabled: z.boolean(),
  offer: z.record(z.string(), z.unknown()),
  attribution: attributionSchema,
  sort_order: z.number().int().min(0).max(99).optional(),
}).strict()

export const landingPagePublishSchema = z.object({
  publish_state: z.enum(LANDING_PAGE_PUBLISH_STATES),
  // A path on this host only (REDIRECT_PATH_RE, shared with the editor).
  redirect_to: z.string().max(300)
    .regex(REDIRECT_PATH_RE)
    .refine((v) => new URL(v, 'https://placeholder.invalid').origin === 'https://placeholder.invalid', 'must be a same-site path')
    .nullable().optional(),
}).strict()
