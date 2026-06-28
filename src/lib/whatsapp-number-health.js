// WhatsApp number health — the Meta phone-number quality rating + messaging tier,
// surfaced on the /communications dashboard and alerted on a downgrade. Fetched by
// the refresh-whatsapp-health cron and stored on whatsapp_numbers (mig 329).

import { META_API_URL } from './whatsapp-config'

// Quality: GREEN (best) > YELLOW > RED (worst). UNKNOWN / null = not ranked.
export const QUALITY_RANK = Object.freeze({ RED: 1, YELLOW: 2, GREEN: 3 })

// Messaging limit tiers, worst → best (business-initiated conversations per 24h).
export const TIER_RANK = Object.freeze({
  TIER_50: 0, TIER_250: 1, TIER_1K: 2, TIER_10K: 3, TIER_100K: 4, UNLIMITED: 5,
})

// True only when both values are known ranks and `next` is strictly worse.
export function qualityDowngraded(prev, next) {
  const p = QUALITY_RANK[prev]
  const n = QUALITY_RANK[next]
  return p != null && n != null && n < p
}

export function tierDowngraded(prev, next) {
  const p = TIER_RANK[prev]
  const n = TIER_RANK[next]
  return p != null && n != null && n < p
}

// Human label for the messaging tier (the operator-facing "daily conversation limit").
export function tierLabel(tier) {
  switch (tier) {
    case 'TIER_50': return '50 / day'
    case 'TIER_250': return '250 / day'
    case 'TIER_1K': return '1,000 / day'
    case 'TIER_10K': return '10,000 / day'
    case 'TIER_100K': return '100,000 / day'
    case 'UNLIMITED': return 'Unlimited'
    default: return tier || '—'
  }
}

// Intent token for a quality rating card (un1t-* light theme — -700 ramp).
export function qualityAccent(rating) {
  if (rating === 'GREEN') return 'text-emerald-600'
  if (rating === 'YELLOW') return 'text-amber-600'
  if (rating === 'RED') return 'text-red-600'
  return 'text-un1t-subtle'
}

// If health worsened (quality drop OR tier downgrade), the reason to alert on;
// else null. Both args are { quality_rating, messaging_limit_tier }.
export function healthDowngradeReason(prev, next) {
  if (qualityDowngraded(prev?.quality_rating, next?.quality_rating)) {
    return `quality dropped ${prev.quality_rating} → ${next.quality_rating}`
  }
  if (tierDowngraded(prev?.messaging_limit_tier, next?.messaging_limit_tier)) {
    return `messaging limit lowered ${tierLabel(prev.messaging_limit_tier)} → ${tierLabel(next.messaging_limit_tier)}`
  }
  return null
}

// Fetch a number's health from the Meta Graph API. Returns the parsed fields;
// throws on a Meta error (e.g. a token without whatsapp_business_management scope —
// the caller stores null + logs, so a bad token degrades to "unavailable").
export async function fetchNumberHealth({ phoneNumberId, token }) {
  const url = `${META_API_URL}/${phoneNumberId}?fields=quality_rating,messaging_limit_tier,name_status,display_phone_number,verified_name`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message || 'Meta number-health fetch failed')
  return {
    quality_rating: json.quality_rating || null,
    messaging_limit_tier: json.messaging_limit_tier || null,
    name_status: json.name_status || null,
  }
}
