// OFFERSEDIT.1 — the rules for creating and editing a studio's sale offers
// (public.sale_offers) from the CRM, step 4 offers design (Richard's
// decisions 19 Nov 2026: owners and masters edit, at their own studio).
//
// Until now an offer could only be set up with SQL. These rules keep the
// editor from saving an offer the storefront could not sell:
//   * the payment rail (offerRail, the one rule the page and the checkout
//     share) must not be 'not_configured' for an ACTIVE offer: a membership or
//     pack at a un1t.online studio needs its un1t.online product, and a row
//     carrying a product id anywhere else would never reach Revolut;
//   * that product must be in the studio's un1t.online mirror, and at the
//     SAME price: the checkout refuses a mismatch, so an active offer that
//     disagrees could not be bought.
// An inactive offer may be saved with either problem: it is a draft, and the
// editor shows what stops it from going live.
import { z } from 'zod'
import { offerRail } from '@/lib/offer-studios'

export const OFFER_CATEGORIES = Object.freeze(['membership', 'class_pack', 'gift_card'])

/** Columns the editor reads and returns. Named, never `*`. */
export const OFFER_EDITOR_COLUMNS = 'id, location_id, slug, category, name, bonus_headline, description, fine_print, price_cents, currency, active, starts_at, ends_at, sort, stock_limit, un1t_product_id, updated_at'

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date and time')
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/

const fields = {
  name: z.string().trim().min(1, 'Give the offer a name').max(120),
  category: z.enum(OFFER_CATEGORIES),
  bonus_headline: z.string().trim().min(1, 'Add a headline for the bonus').max(160),
  description: z.string().trim().max(4000),
  fine_print: z.string().trim().max(4000),
  price_cents: z.number().int().min(1, 'The price must be above zero').max(10_000_00),
  active: z.boolean(),
  starts_at: isoDate,
  ends_at: isoDate.nullable(),
  sort: z.number().int().min(0).max(1000),
  stock_limit: z.number().int().min(1).max(100000).nullable(),
  un1t_product_id: z.string().trim().max(120).nullable(),
}

const datesInOrder = (o) => !o.ends_at || !o.starts_at || Date.parse(o.ends_at) > Date.parse(o.starts_at)
const DATES_MESSAGE = { message: 'The end must be after the start', path: ['ends_at'] }

export const offerCreateSchema = z.object({
  ...fields,
  slug: z.string().trim().toLowerCase().regex(SLUG_RE, 'Web address: lowercase letters, digits and hyphens').optional(),
  description: fields.description.default(''),
  fine_print: fields.fine_print.default(''),
  active: fields.active.default(false),
  starts_at: fields.starts_at.optional(),
  ends_at: fields.ends_at.default(null),
  sort: fields.sort.default(0),
  stock_limit: fields.stock_limit.default(null),
  un1t_product_id: fields.un1t_product_id.default(null),
}).refine(datesInOrder, DATES_MESSAGE)

// The web address never changes once made: links and ads point at it.
export const offerUpdateSchema = z.object(fields).partial().refine(datesInOrder, DATES_MESSAGE)

/** A web address from the name: "30 + 10 Pack!" -> "30-10-pack". */
export function slugFromName(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '')
  return s || 'offer'
}

/**
 * What stops this offer from being sold. Pure.
 * @param {{ membership_source?: string|null }} location
 * @param {{ category: string, un1t_product_id?: string|null, price_cents: number }} offer
 * @param {{ price_cents: number|null }|null} product  the mirrored un1t.online product, or null
 * @returns {Array<{ code: string, message: string }>}
 */
export function offerSaleProblems(location, offer, product) {
  const rail = offerRail(location, offer)
  if (rail === 'not_configured') {
    const un1tStudio = location?.membership_source === 'un1t_online'
    return [{
      code: 'not_configured',
      message: un1tStudio
        ? 'Memberships and class packs here are sold through un1t.online: pick the un1t.online product.'
        : 'Only a membership or class pack at a un1t.online studio can carry a un1t.online product. Clear it to sell through the card checkout.',
    }]
  }
  if (rail !== 'un1t_online') return []
  if (!product) {
    return [{ code: 'product_missing', message: 'That un1t.online product is not in this studio\'s product list. Check the id, or wait for the next sync.' }]
  }
  if (product.price_cents !== offer.price_cents) {
    return [{ code: 'price_mismatch', message: 'The price differs from the un1t.online product\'s, so buyers would be turned away. Make the two agree.' }]
  }
  return []
}
