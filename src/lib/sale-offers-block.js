// SALEPAGE.1 — the server side of a page-builder sale (offer type `sale`,
// block `sale_offers`). Server-only: it reads with the service-role client.
//
// The studio's offers come from public.sale_offers (Settings > Offers), and
// only those the storefront could sell today are offered: active, open now or
// opening later (storefrontOffers), and passing the one payment-rail rule with
// a matching un1t.online price (offerSaleProblems). Each offer is bought on its
// existing /offers/<studio>/<slug> page, so a studio with no /offers key cannot
// run a sale page yet.
//
// A failed read answers { ok: false }: the caller shows a try-again note or,
// for readiness, throws. Never "no offers", which would read as a sold-out sale.
import { storefrontOffers } from '@/lib/offers-storefront'
import { studioForLocationSlug } from '@/lib/offer-studios'
import { offerSaleProblems } from '@/lib/offers-admin'
import { readUn1tProducts, productFor } from '@/lib/offers-admin-db'
import { logError } from '@/lib/log'

const OFFER_COLUMNS = 'id, location_id, slug, category, name, bonus_headline, description, fine_print, price_cents, currency, active, starts_at, ends_at, sort, stock_limit, un1t_product_id'

/**
 * @param {object} db  service-role client
 * @param {string} locationId
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<{ ok: true, studioKey: string|null, offers: object[] } | { ok: false }>}
 */
export async function sellableSaleOffers(db, locationId, { now = new Date() } = {}) {
  const { data: location, error: locErr } = await db.from('locations')
    .select('id, slug, membership_source').eq('id', locationId).maybeSingle()
  if (locErr || !location) {
    logError('sale-page', 'studio unreadable for its sale offers', { locationId, code: locErr?.code ?? null })
    return { ok: false }
  }
  const { data: rows, error } = await db.from('sale_offers')
    .select(OFFER_COLUMNS)
    .eq('location_id', locationId)
    .eq('active', true)
    .order('sort', { ascending: true })
  if (error) {
    logError('sale-page', 'sale offers unreadable', { locationId, code: error.code ?? null })
    return { ok: false }
  }
  const products = await readUn1tProducts(db, location)
  if (products.error) return { ok: false }
  const offers = storefrontOffers(rows || [], now)
    .filter((o) => offerSaleProblems(location, o, productFor(products.list, o.un1t_product_id)).length === 0)
    // The product id is operator configuration; the page never needs it.
    .map(({ un1t_product_id: _drop, ...o }) => o)
  return { ok: true, studioKey: studioForLocationSlug(location.slug)?.key || null, offers }
}

/**
 * The offers a sale page shows at one studio, in the order the studio chose,
 * keeping only those still sellable. Pure.
 * @param {string[]} offerIds  landing_page_studios.offer.offer_ids
 * @param {object[]} sellable  sellableSaleOffers(...).offers
 */
export function chosenSaleOffers(offerIds, sellable) {
  const byId = new Map((sellable || []).map((o) => [o.id, o]))
  return (Array.isArray(offerIds) ? offerIds : []).map((id) => byId.get(id)).filter(Boolean)
}

/**
 * What the sale card shows for one offer: plain data, never the row. Pure.
 * @param {object} offer  a sellableSaleOffers row
 * @param {string} studioKey  its /offers studio key
 * @param {{ now?: Date, formatEuro: (cents: number) => string }} opts
 */
export function saleOfferView(offer, studioKey, { now = new Date(), formatEuro }) {
  const opens = offer.starts_at && Date.parse(offer.starts_at) > now.getTime()
  return {
    id: offer.id,
    name: offer.name,
    bonus: offer.bonus_headline || null,
    price: formatEuro(offer.price_cents),
    href: `/offers/${studioKey}/${offer.slug}`,
    opensLabel: opens ? 'Opens soon' : null,
  }
}
