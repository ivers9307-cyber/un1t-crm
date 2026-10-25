// PAIDTRIAL.1 — pure helpers for the paid trial product (the /trial page).
// No IO. The block itself is PAID_TRIAL_DEFAULT in landing-page-blocks.js.

import { resolveLandingPath } from '@/lib/public-landing'

export const PAID_TRIAL_LEAD_SOURCE = 'meta_trial'
export const PAID_TRIAL_MIN_CENTS = 100
export const PAID_TRIAL_MAX_CENTS = 50_000

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * The product the page sells, read off a studio's landing blocks. `null` when
 * the row has no paid_trial block or the block is not sellable (no price, or
 * the Glofox product is half-configured): the page shows nothing to buy and
 * the POST refuses with `not_configured`, never a guess at a default plan.
 * @returns {null | {
 *   productName: string, priceCents: number, currency: string, durationDays: number,
 *   membershipId: string, planCode: string, tag: string, leadSource: string,
 *   eventSourceUrl: string, block: object }}
 */
export function paidTrialConfigFromBlocks(blocks, landingPath) {
  const path = resolveLandingPath(landingPath)
  const list = Array.isArray(blocks) ? blocks : []
  const b = list.find((x) => x && typeof x === 'object' && x.type === 'paid_trial')
  if (!b) return null
  const rawPrice = Number(b.price_cents)
  const priceCents = Number.isFinite(rawPrice) ? Math.floor(rawPrice) : 0
  if (priceCents < PAID_TRIAL_MIN_CENTS || priceCents > PAID_TRIAL_MAX_CENTS) return null
  const membershipId = str(b.membership_id)
  const planCode = str(b.plan_code)
  if (!membershipId || !planCode) return null
  const rawDays = Number(b.duration_days)
  const durationDays = Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 365 ? Math.floor(rawDays) : 14
  return {
    productName: str(b.product_name) || `${durationDays} day trial`,
    priceCents,
    currency: str(b.currency)?.toUpperCase() || 'EUR',
    durationDays,
    membershipId,
    planCode,
    tag: str(b.tag) || `${path}-trial`,
    leadSource: str(b.lead_source) || PAID_TRIAL_LEAD_SOURCE,
    eventSourceUrl: str(b.event_source_url) || `https://www.un1tdublin.com/trial`,
    block: b,
  }
}

/** '€39' / '€39.50' for the panel and the checkout line. */
export function formatTrialPrice(cents, currency = 'EUR') {
  const n = (Number(cents) || 0) / 100
  const sym = currency === 'EUR' ? '€' : `${currency} `
  return Number.isInteger(n) ? `${sym}${n}` : `${sym}${n.toFixed(2)}`
}

/** The ticks list, position-preserving, blanks dropped. */
export function trialTicks(block) {
  const t = Array.isArray(block?.ticks) ? block.ticks : []
  return t.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 6)
}

/**
 * What the buyer's screen shows for one purchase row's public status.
 * 'granted' only when the Glofox plan is on the account; 'paid' is money in
 * and the grant in flight (the screen says so, never "it's on your account").
 */
export function trialPurchasePublicState(row) {
  if (!row) return 'notfound'
  if (row.status === 'granted') return 'granted'
  if (row.status === 'payment_failed' || row.payment_status === 'failed' || row.payment_status === 'expired') return 'failed'
  if (row.payment_status === 'paid') return 'paid'
  return 'pending'
}
