// NEWSTART.1 — the Glofox membership plan behind each Glofox corp promo.
//
// SERVER-ONLY by convention (no server-only package in this repo): these ids are operator configuration for the Glofox purchase
// and never reach a client component. Blank ids mean the plan has not been
// created in Glofox yet, and the promo stays off (glofoxPlanForPromo -> null).

import { CORP_PROMOS } from '@/lib/corp-promos'

const CORP_PROMO_GLOFOX_PLANS = Object.freeze({
  'stillorgan-newstart': Object.freeze({ membershipId: '', planCode: '', planName: 'New Start' }),
})

/** @returns {{ membershipId: string, planCode: string, planName: string } | null} */
export function glofoxPlanForPromo(key) {
  if (typeof key !== 'string' || !Object.hasOwn(CORP_PROMO_GLOFOX_PLANS, key)) return null
  const p = CORP_PROMO_GLOFOX_PLANS[key]
  if (!p.membershipId?.trim() || !p.planCode?.trim()) return null
  return { membershipId: p.membershipId.trim(), planCode: p.planCode.trim(), planName: p.planName }
}

/** Keys of the Glofox corp promos (registry platform 'glofox'). */
export function glofoxCorpPromoKeys() {
  return Object.values(CORP_PROMOS).filter((p) => p.platform === 'glofox').map((p) => p.key)
}

/**
 * Lower-cased, trimmed Glofox plan names of the Glofox corp promos. Names only,
 * so it answers even while a plan's ids are still blank (promo off).
 */
export function glofoxCorpPromoPlanNames() {
  return glofoxCorpPromoKeys()
    .map((k) => (Object.hasOwn(CORP_PROMO_GLOFOX_PLANS, k) ? CORP_PROMO_GLOFOX_PLANS[k].planName : ''))
    .map((n) => String(n || '').trim().toLowerCase())
    .filter(Boolean)
}
