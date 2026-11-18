// offer-stock.js — real stock limits on sale offers (OFFERSTOCK.1, mig 850).
//
// sale_offers.stock_limit is how many may be sold (NULL: no limit). What has
// been used is counted by the database, offer_stock_counts: every paid
// purchase, plus checkouts opened on the page in the last 35 minutes. The
// number a customer sees is only ever derived from those rows; nothing here
// lowers it on a timer.
//
// The binding check is the enforce_offer_stock trigger, which holds a lock on
// the offer. Everything in this file is display, or an early refusal that saves
// the buyer a form and us a provider call. So a failed read here shows no stock
// line and lets the checkout go on: it never reads as "sold out", and never
// invents a number.
import { logWarn } from '@/lib/log'

// A number is shown once this few are left; above it the page says nothing.
export const OFFER_LOW_STOCK_AT = 5

// The trigger's SQLSTATEs.
export const STOCK_SOLD_OUT_CODE = 'OFS01'
export const STOCK_HELD_CODE = 'OFS02'

/** 'sold_out' | 'all_reserved' for a trigger refusal; null for any other error. */
export function stockRefusalState(error) {
  if (error?.code === STOCK_SOLD_OUT_CODE) return 'sold_out'
  if (error?.code === STOCK_HELD_CODE) return 'all_reserved'
  return null
}

/**
 * @param {{ stock_limit?: number|null }} offer
 * @param {{ sold?: number, held?: number }|null|undefined} counts
 * @returns {null | { limit: number, sold: number, held: number, left: number,
 *   state: 'available'|'low'|'all_reserved'|'sold_out' }} null: no limit, or no counts
 */
export function offerStockStatus(offer, counts) {
  const limit = offer?.stock_limit
  if (!Number.isInteger(limit) || limit <= 0 || !counts) return null
  const sold = Number(counts.sold) || 0
  const held = Number(counts.held) || 0
  const left = Math.max(0, limit - sold - held)
  let state = 'available'
  if (sold >= limit) state = 'sold_out'
  else if (left === 0) state = 'all_reserved'
  else if (left <= OFFER_LOW_STOCK_AT) state = 'low'
  return { limit, sold, held, left, state }
}

/**
 * The counts for these offers, or null when they could not be read.
 * @returns {Promise<Map<string, { sold: number, held: number }>|null>}
 */
export async function readOfferStockCounts(db, offerIds, { excludeEmail = null } = {}) {
  if (offerIds.length === 0) return new Map()
  const { data, error } = await db.rpc('offer_stock_counts', {
    p_offer_ids: offerIds,
    p_exclude_email: excludeEmail,
  })
  if (error) {
    logWarn('offers', 'offer stock unreadable', { offers: offerIds.length, code: error.code ?? null })
    return null
  }
  return new Map((data || []).map((r) => [r.offer_id, { sold: r.sold, held: r.held }]))
}

/**
 * Stock status per offer id, for the offers that carry a limit. An unreadable
 * count gives an empty map: the page shows no line rather than a wrong one.
 * @returns {Promise<Map<string, NonNullable<ReturnType<typeof offerStockStatus>>>>}
 */
export async function readOfferStock(db, offers) {
  const limited = (offers || []).filter((o) => o?.stock_limit != null)
  const out = new Map()
  const counts = await readOfferStockCounts(db, limited.map((o) => o.id))
  if (!counts) return out
  for (const o of limited) {
    const status = offerStockStatus(o, counts.get(o.id))
    if (status) out.set(o.id, status)
  }
  return out
}

/** The short line on a card or product page; null when there is nothing to say. */
export function offerStockLine(status, copy) {
  if (status?.state === 'low') return copy.stockLeft.replaceAll('{n}', String(status.left))
  if (status?.state === 'all_reserved') return copy.stockReserved
  return null
}
