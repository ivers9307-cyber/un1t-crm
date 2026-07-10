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

// WA-QUALITY.5 — quality collapse detected by the health POLL (the webhook
// path pauses on FLAGGED via whatsapp-number-events; the 30-min poll can be
// FIRST to record RED and must trigger the same drip auto-pause). Fires only
// on the transition INTO RED/FLAGGED — a number sitting at RED doesn't
// re-pause/re-page every tick — and treats a first-seed RED (prev null) as a
// transition: RED is an emergency regardless of what we knew before. Pure.
export function pollQualityPauseReason(prevRating, nextRating) {
  const collapsed = (r) => r === 'RED' || r === 'FLAGGED'
  if (!collapsed(nextRating) || collapsed(prevRating)) return null
  return `the number quality was rated ${nextRating} by Meta`
}

// WA-TOKEN.1 — is this fetchNumberHealth failure a Meta AUTH failure (dead /
// expired / revoked access token: error code 190, type OAuthException) rather
// than a scope gap or transient hiccup? A dying System User token silently
// kills EVERY outbound send (the invariant that bit agent sends before), so
// the poll classifies it distinctly instead of degrading to "unavailable". Pure.
export function isMetaAuthError(err) {
  if (!err) return false
  if (String(err.metaCode ?? '') === '190') return true
  return /oauthexception/i.test(String(err.metaType || ''))
}

// Token-state transition for one poll tick. `prevInvalidAt` is the stored
// whatsapp_numbers.token_invalid_at (mig 393); alerts key off the TRANSITION
// (mirroring the webhook idempotency style) so managers are paged ONCE per
// death/recovery, not every 30 minutes.
export function tokenTransition(prevInvalidAt, authErrorNow) {
  if (authErrorNow && !prevInvalidAt) return 'invalidated'
  if (!authErrorNow && prevInvalidAt) return 'recovered'
  return null
}

export function tokenInvalidNotification(label) {
  const num = label || 'a WhatsApp number'
  return {
    title: 'WhatsApp access token INVALID',
    body: `🚨 Meta rejected the access token for ${num} (OAuth error 190). Every outbound WhatsApp send — ` +
      'Mia, broadcasts, sequences, reminders — is failing silently until it is replaced. Generate a PERMANENT ' +
      'System User token in Meta Business Manager (never a 24h temp token) and update the number under ' +
      'Settings → Locations → Integrations → WhatsApp.',
  }
}

export function tokenRecoveredNotification(label) {
  const num = label || 'a WhatsApp number'
  return {
    title: 'WhatsApp access token recovered',
    body: `✅ The access token for ${num} is valid again — outbound sends are back.`,
  }
}

// Fetch a number's health from the Meta Graph API. Returns the parsed fields;
// throws on a Meta error (e.g. a token without whatsapp_business_management scope —
// the caller stores null + logs, so a bad token degrades to "unavailable").
// The thrown error carries Meta's code/type (metaCode/metaType) so the poll
// can classify token deaths (isMetaAuthError) instead of lumping them in.
export async function fetchNumberHealth({ phoneNumberId, token }) {
  const url = `${META_API_URL}/${phoneNumberId}?fields=quality_rating,messaging_limit_tier,name_status,display_phone_number,verified_name`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const json = await res.json()
  if (json.error) {
    const err = new Error(json.error.message || 'Meta number-health fetch failed')
    err.metaCode = json.error.code ?? null
    err.metaType = json.error.type || null
    throw err
  }
  return {
    quality_rating: json.quality_rating || null,
    messaging_limit_tier: json.messaging_limit_tier || null,
    name_status: json.name_status || null,
  }
}
