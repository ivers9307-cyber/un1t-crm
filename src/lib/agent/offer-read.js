// MIAPAGES.1 — the live read behind Mia's list_current_offers tool: every live
// landing page and every sellable storefront offer in one organisation, per
// studio, judged by the same rules the public pages use, so Mia and a page
// never disagree about what can be bought right now.
//
// SERVER ONLY. The studio rows are read with STUDIO_ROW_COLUMNS, which embeds
// `locations.settings` (credentials), because the page's own readiness gate
// (trialEntryFromRow) needs the un1t.online write switch. Nothing of a row
// leaves this file: the entries are built field by field in offer-view.js.
//
// Scoping: every read is by the caller's organisation id, then by a location
// id that belongs to it (the `locations` read is the list of them).
//
// A failed read is "unknown", never "nothing on offer": a studio whose pages
// or store could not be read carries pages_unreadable / store_unreadable, and
// only when nothing at all could be read is the answer { ok: false }.
//
// The design is docs/superpowers/specs/2026-11-23-mia-live-pages-and-offers-design.md.
import {
  PAGE_COLUMNS, STUDIO_ROW_COLUMNS, isPageVisible, pageStudioRows, mergedBlocksFor, offerReady,
} from '@/lib/landing-pages'
import { OFFER_BLOCK_TYPE } from '@/lib/landing-page-offers'
import { trialEntryFromRow } from '@/lib/trial-studios'
import { readCorpPromo } from '@/lib/corp-promos-db'
import { isOpenWeek, openWeekState } from '@/lib/open-week'
import { sellableSaleOffers } from '@/lib/sale-offers-block'
import { readOfferStock } from '@/lib/offer-stock'
import { zoneOfLocation } from '@/lib/location-time'
import { logWarn } from '@/lib/log'
import { pageEntry, storeEntry, rankPages } from './offer-view'

const LOG_MODULE = 'mia-offers'
const LOCATION_COLUMNS = 'id, name, slug, timezone, active'
// Offer types whose page sells or gives something of its own.
const SELLING_TYPES = new Set(['paid_trial', 'one_class', 'class_funnel', 'promo_credits'])

class StudioUnreadable extends Error {}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** The address a customer uses for this page at this studio (the public route's own forms). */
function pageUrl(baseUrl, page, publicPath) {
  if (page.scope === 'all') return `${baseUrl}/${page.slug}?studio=${encodeURIComponent(publicPath)}`
  return `${baseUrl}/${page.slug}`
}

/**
 * Would this page take a customer at this studio right now? The page's own
 * gates: the trial entry the /trial card reads, the promo row and (for an open
 * week) its window, offerReady for a class page.
 * @returns {Promise<null | { mergedOffer: object, promo: object|null, endsOn: string|null }>} null: not now
 * @throws {StudioUnreadable} a read failed
 */
async function liveOffer(db, { page, row, publicPath, zone, now }) {
  const blockType = OFFER_BLOCK_TYPE[page.offer_type]
  const merged = mergedBlocksFor({ page, studio: row }).find((b) => b?.type === blockType) || null
  if (!merged) return null
  if (page.offer_type === 'paid_trial') {
    const entry = await trialEntryFromRow(db, { row, publicPath, mergedBlock: merged })
    if (entry.unreadable) throw new StudioUnreadable('trial product')
    if (!entry.sellable) return null
    return { mergedOffer: { ...merged, price_cents: entry.config.priceCents, currency: entry.config.currency }, promo: null, endsOn: null }
  }
  if (page.offer_type === 'promo_credits') {
    const key = str(merged.promo_key)
    if (!key) return null
    const res = await readCorpPromo(db, { locationId: row.location_id, key })
    if (!res.ok) throw new StudioUnreadable('promo')
    const promo = res.promo
    if (!promo || !promo.live) return null
    if (isOpenWeek(promo)) {
      if (openWeekState(promo, zone, now) !== 'open') return null
      return { mergedOffer: merged, promo, endsOn: promo.windowEndsOn }
    }
    return { mergedOffer: merged, promo, endsOn: null }
  }
  if (!offerReady({ page, studio: row, landingPath: publicPath })) return null
  return { mergedOffer: merged, promo: null, endsOn: null }
}

/** One studio's ranked page entries. */
async function studioPages(db, { location, pages, rowsByPage, publicPath, baseUrl, now }) {
  const zone = zoneOfLocation(location)
  let unreadable = false
  const found = []
  for (const page of pages) {
    const row = pageStudioRows(page, rowsByPage.get(page.id) || []).find((r) => r.location_id === location.id && r.enabled === true)
    if (!row) continue
    // No studio page, no public path: the public route answers 404 for it too.
    if (!publicPath) continue
    let offer = null
    if (SELLING_TYPES.has(page.offer_type)) {
      try {
        offer = await liveOffer(db, { page, row, publicPath, zone, now })
      } catch (err) {
        unreadable = true
        logWarn(LOG_MODULE, 'page offer unreadable; page left out', { locationId: location.id, slug: page.slug, errClass: err?.name })
        continue
      }
      // A campaign page with nothing to give right now is not offered at all;
      // a studio page is still the studio's own page.
      if (!offer && page.kind !== 'studio') continue
    }
    found.push({ page, offer })
  }
  // One trial, one link: a studio page does not repeat an offer a campaign page carries.
  const campaignTypes = new Set(found.filter((f) => f.page.kind !== 'studio' && f.offer).map((f) => f.page.offer_type))
  const items = found.map(({ page, offer }) => {
    const withOffer = Boolean(offer) && !(page.kind === 'studio' && campaignTypes.has(page.offer_type))
    return {
      page,
      withOffer,
      endsOn: withOffer ? offer.endsOn : null,
      entry: pageEntry({
        page, mergedOffer: offer?.mergedOffer || null, promo: offer?.promo || null, zone,
        url: pageUrl(baseUrl, page, publicPath), withOffer, studioName: location.name, now,
      }),
    }
  })
  return { pages: rankPages(items), unreadable }
}

/** One studio's storefront entries. */
async function studioStore(db, { location, baseUrl, now }) {
  const sale = await sellableSaleOffers(db, location.id, { now })
  if (!sale?.ok) return { store: [], unreadable: true }
  if (!sale.studioKey || sale.offers.length === 0) return { store: [], unreadable: false }
  let stock = new Map()
  try {
    stock = (await readOfferStock(db, sale.offers)) || new Map()
  } catch (err) {
    // The storefront shows no stock line when the count is unreadable; so does Mia.
    logWarn(LOG_MODULE, 'offer stock unreadable; offers listed without it', { locationId: location.id, errClass: err?.name })
  }
  const zone = zoneOfLocation(location)
  return {
    unreadable: false,
    store: sale.offers.map((offer) => storeEntry({
      offer, stock: stock.get(offer.id) || null, zone, now,
      url: `${baseUrl}/offers/${sale.studioKey}/${offer.slug}`,
    })),
  }
}

/**
 * Everything on offer online in one organisation, per studio, the thread's
 * studio first. Never throws.
 * @param {object} db service-role client
 * @param {{ organizationId: string, threadLocationId: string, baseUrl: string, now?: Date }} opts
 * @returns {Promise<{ ok: true, studios: Array<{ studio: string, this_conversation: boolean,
 *   pages: object[], store: object[], pages_unreadable?: true, store_unreadable?: true }> } | { ok: false }>}
 */
export async function readCurrentOffers(db, { organizationId, threadLocationId, baseUrl, now = new Date() } = {}) {
  if (!db || !organizationId || !baseUrl) return { ok: false }
  try {
    const { data: locs, error: locErr } = await db.from('locations')
      .select(LOCATION_COLUMNS)
      .eq('organization_id', organizationId)
      .order('name', { ascending: true })
    if (locErr) {
      logWarn(LOG_MODULE, 'studios unreadable', { organizationId, code: locErr.code ?? null })
      return { ok: false }
    }
    const locations = (locs || []).filter((l) => l.active !== false)

    // Pages and their studio rows. Every page of the organisation is read (a
    // studio's public path is its studio page's slug, whatever its state);
    // only the live ones are offered.
    let pagesFailed = false
    let livePages = []
    const publicPaths = new Map()
    const rowsByPage = new Map()
    const { data: pageRows, error: pageErr } = await db.from('landing_pages')
      .select(PAGE_COLUMNS)
      .eq('organization_id', organizationId)
      .order('slug', { ascending: true })
    if (pageErr) {
      pagesFailed = true
      logWarn(LOG_MODULE, 'pages unreadable', { organizationId, code: pageErr.code ?? null })
    } else {
      for (const p of pageRows || []) {
        if (p.kind === 'studio' && p.primary_location_id) publicPaths.set(p.primary_location_id, p.slug)
      }
      livePages = (pageRows || []).filter((p) => isPageVisible(p.publish_state))
      if (livePages.length > 0) {
        const { data: studioRows, error: rowErr } = await db.from('landing_page_studios')
          .select(STUDIO_ROW_COLUMNS)
          .in('page_id', livePages.map((p) => p.id))
          .eq('enabled', true)
          .order('sort_order', { ascending: true })
        if (rowErr) {
          pagesFailed = true
          logWarn(LOG_MODULE, 'page studio rows unreadable', { organizationId, code: rowErr.code ?? null })
        } else {
          for (const r of studioRows || []) {
            if (!rowsByPage.has(r.page_id)) rowsByPage.set(r.page_id, [])
            rowsByPage.get(r.page_id).push(r)
          }
        }
      }
    }

    const studios = []
    let anyStoreRead = false
    for (const location of locations) {
      let pages = { pages: [], unreadable: pagesFailed }
      if (!pagesFailed) {
        try {
          pages = await studioPages(db, { location, pages: livePages, rowsByPage, publicPath: publicPaths.get(location.id) || null, baseUrl, now })
        } catch (err) {
          pages = { pages: [], unreadable: true }
          logWarn(LOG_MODULE, 'studio pages unreadable', { locationId: location.id, errClass: err?.name })
        }
      }
      let store
      try {
        store = await studioStore(db, { location, baseUrl, now })
      } catch (err) {
        store = { store: [], unreadable: true }
        logWarn(LOG_MODULE, 'studio store threw', { locationId: location.id, errClass: err?.name })
      }
      if (!store.unreadable) anyStoreRead = true
      else logWarn(LOG_MODULE, 'studio store unreadable', { locationId: location.id })
      const mine = location.id === threadLocationId
      const hasContent = pages.pages.length > 0 || store.store.length > 0
      // A studio with nothing to show is left out, unless a read failed for
      // it: "unknown" must reach Mia, never silence, for any studio.
      if (!hasContent && !pages.unreadable && !store.unreadable) continue
      studios.push({
        studio: location.name,
        this_conversation: mine,
        pages: pages.pages,
        store: store.store,
        ...(pages.unreadable ? { pages_unreadable: true } : {}),
        ...(store.unreadable ? { store_unreadable: true } : {}),
      })
    }
    if (pagesFailed && !anyStoreRead) return { ok: false }
    studios.sort((a, b) => Number(b.this_conversation) - Number(a.this_conversation) || a.studio.localeCompare(b.studio))
    return { ok: true, studios }
  } catch (err) {
    logWarn(LOG_MODULE, 'current offers read threw', { organizationId, errClass: err?.name })
    return { ok: false }
  }
}
