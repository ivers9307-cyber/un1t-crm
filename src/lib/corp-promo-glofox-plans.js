// NEWSTART.1 — the Glofox membership plan behind each Glofox corp promo.
// WAYSIN.2: the plan lives on the promo's corp_promos row (mig 816:
// glofox_membership_id, glofox_plan_code, glofox_plan_name), read through
// src/lib/corp-promos.js.
//
// SERVER-ONLY by convention (no server-only package in this repo): the plan
// ids are operator configuration for the Glofox purchase. They live in the
// corp_promos table and in SEED_GLOFOX_PLANS below, NEVER in a module a client
// component imports (src/lib/corp-promos.js reaches the client bundle;
// tests/corp-promos-client-safe.test.js pins that). At runtime
// glofoxPlanForPromo reads only the row's binding: a promo whose membership id
// or plan code is blank cannot grant (null), and the claim refuses it.

import { listCorpPromos } from '@/lib/corp-promos-db'

/**
 * Mig 816's seed of the Glofox plan bindings, for the migration guard and as
 * documentation only. NOT a runtime fallback: no code path reads it.
 * Created in Glofox by Richard, 5 Nov 2026 ("New Start Free Trial", €0).
 */
export const SEED_GLOFOX_PLANS = Object.freeze({
  'stillorgan-newstart': Object.freeze({ membershipId: '6aec95d590a936f18c065d9f', planCode: '1793889679121', planName: 'New Start Free Trial' }),
})

/**
 * The plan of a promo view (promoView of a corp_promos row): its `glofox`
 * binding, or null when it has none. A seed always answers null.
 * @returns {{ membershipId: string, planCode: string, planName: string | null } | null}
 */
export function glofoxPlanForPromo(promo) {
  const p = promo && typeof promo === 'object' ? promo.glofox : null
  if (!p || typeof p !== 'object') return null
  const membershipId = typeof p.membershipId === 'string' ? p.membershipId.trim() : ''
  const planCode = typeof p.planCode === 'string' ? p.planCode.trim() : ''
  if (!membershipId || !planCode) return null
  return { membershipId, planCode, planName: typeof p.planName === 'string' ? p.planName : null }
}

// The studio's Glofox promos (every one, live or not: a switched-off promo's
// claims are still history).
async function studioGlofoxPromos(db, locationId) {
  const res = await listCorpPromos(db, { locationId })
  if (!res.ok) return res
  return { ok: true, promos: res.promos.filter((p) => p.platform === 'glofox') }
}

/**
 * Keys of the studio's Glofox corp promos.
 * @returns {Promise<{ ok: true, keys: string[] } | { ok: false, error: string }>}
 */
export async function glofoxCorpPromoKeys(db, locationId) {
  const res = await studioGlofoxPromos(db, locationId)
  if (!res.ok) return res
  return { ok: true, keys: res.promos.map((p) => p.key) }
}

/**
 * Lower-cased, trimmed Glofox plan names of the studio's Glofox corp promos.
 * @returns {Promise<{ ok: true, names: string[] } | { ok: false, error: string }>}
 */
export async function glofoxCorpPromoPlanNames(db, locationId) {
  const res = await studioGlofoxPromos(db, locationId)
  if (!res.ok) return res
  const names = res.promos.map((p) => String(p.glofox?.planName || '').trim().toLowerCase()).filter(Boolean)
  return { ok: true, names }
}
