// NEWSTART.1 — the Glofox membership plan behind each Glofox corp promo.
//
// SERVER-ONLY by convention (no server-only package in this repo): these ids are operator configuration for the Glofox purchase
// and never reach a client component. Blank ids mean the plan has not been
// created in Glofox yet, and the promo stays off (glofoxPlanForPromo -> null).

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
