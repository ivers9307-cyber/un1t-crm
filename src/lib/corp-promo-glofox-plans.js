// NEWSTART.1 — the Glofox membership plan behind each Glofox corp promo.
// WAYSIN.2: the plan lives on the promo's corp_promos row (mig 816:
// glofox_membership_id, glofox_plan_code, glofox_plan_name), read through
// src/lib/corp-promos.js.
//
// SERVER-ONLY by convention (no server-only package in this repo): the plan
// ids are operator configuration for the Glofox purchase. A promo whose
// membership id or plan code is blank cannot grant (glofoxPlanForPromo ->
// null), and the claim refuses it.

import { listCorpPromos } from '@/lib/corp-promos'

/**
 * The plan of a promo view (promoView, or a seed): its `glofox` binding, or
 * null when it has none.
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
