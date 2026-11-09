// HOSTPORTAL.2 — the one-line "price right now" on a host's Overview tab, from
// the same tiers and sold counts the public page prices with (publicPricing),
// plus what the public block never shows a buyer: how many places are left.

import { publicPricing, resolvePricingTiers } from '@/lib/pricing-tiers'

// €25, €35.50: whole euros drop the ".00".
function euro(cents) {
  const n = (Number(cents) || 0) / 100
  return `€${Number.isInteger(n) ? n : n.toFixed(2)}`
}

/**
 * "Early bird €25 · 6 of 20 left · then standard €35 · 3 or more people €28 each".
 * No tiers: "€35 per person", or "Free" for a €0 / unset price. `zone` is
 * accepted for the callers' symmetry with the public label; no date is shown.
 */
export function hostPriceLine({ race, soldByTier, nowMs }) {
  const tiers = resolvePricingTiers(race)
  const base = race?.non_member_fee_cents ?? null
  if (tiers.length === 0) return base ? `${euro(base)} per person` : 'Free'

  const pricing = publicPricing({ race, nowMs, soldByTier: soldByTier || {} })
  const parts = []
  if (pricing.current) {
    parts.push(`${pricing.current.name} ${euro(pricing.current.price_cents)}`)
    const tier = tiers.find((t) => t.id === pricing.current.id)
    if (tier?.capacity != null) {
      const left = Math.max(0, tier.capacity - (Number(soldByTier?.[tier.id]) || 0))
      parts.push(`${left} of ${tier.capacity} left`)
    }
    if (pricing.next) parts.push(`then ${pricing.next.name} ${euro(pricing.next.price_cents)}`)
    else if (base === 0) parts.push('then free')
    else if (base != null) parts.push(`then standard ${euro(base)}`)
  } else {
    parts.push(base ? `${euro(base)} per person` : 'Free')
  }
  // Only the group tier that is open right now (an ended or full one is not offered).
  if (pricing.group) parts.push(`${pricing.group.min_people} or more people ${euro(pricing.group.price_cents)} each`)
  return parts.join(' · ')
}
