// meta-pixel-lead — BROWSERLEAD.1: the browser half of the Lead event.
//
// The server sends every Lead to Meta's Conversions API (meta-capi.js) and
// that event can only carry what the form typed. The Pixel, when cookie
// consent let it load, can ALSO send the Lead, and its copy carries what the
// server never sees: Meta's own browser cookies and the person's logged-in
// Facebook/Instagram session. Both copies share one event id so Meta counts
// a single lead and keeps the better match from either side.
//
// Manual advanced matching: fbq('init', id, userData) with the normalised raw
// values; the Pixel hashes them in the browser before anything leaves it.
// Client-only; every path no-ops without window.fbq (no consent, blocked).

import { normalizeEmailForMeta, normalizePhoneForMeta, normalizeNameForMeta } from '@/lib/meta-match-normalize'

/** A fresh id for one lead, shared by the browser and server events. */
export function newLeadEventId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* fall through */ }
  return `lead-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

/** Shape the Pixel wants for manual advanced matching; blanks left out. */
export function pixelUserData({ email, phone, firstName, lastName } = {}) {
  const out = {}
  const em = normalizeEmailForMeta(email)
  const ph = normalizePhoneForMeta(phone)
  const fn = normalizeNameForMeta(firstName)
  const ln = normalizeNameForMeta(lastName)
  if (em) out.em = em
  if (ph) out.ph = ph
  if (fn) out.fn = fn
  if (ln) out.ln = ln
  if (ph && ph.startsWith('353')) out.country = 'ie'
  return out
}

/**
 * Send the browser Lead. Returns true when fbq took it, false when the Pixel
 * is not on the page (no consent yet, ad blocker, SSR). Never throws.
 */
export function fireBrowserLead({ pixelIds, eventId, userData, contentName, fbq } = {}) {
  const f = fbq || (typeof window !== 'undefined' ? window.fbq : undefined)
  if (typeof f !== 'function' || !eventId) return false
  try {
    const ids = Array.isArray(pixelIds) ? pixelIds.filter(Boolean) : []
    if (userData && Object.keys(userData).length) {
      for (const id of ids) f('init', id, userData)
    }
    const params = contentName ? { content_name: contentName } : {}
    f('track', 'Lead', params, { eventID: eventId })
    return true
  } catch { return false }
}

/** TRIALCHECKOUT.1 — the InitiateCheckout event id derived from the Lead's, so browser and server agree. */
export function checkoutEventIdFor(leadEventId) {
  return leadEventId ? `trialcheckout-${leadEventId}` : null
}

/**
 * TRIALCHECKOUT.1 — the browser InitiateCheckout, fired at the same moment as
 * the paid trial's Lead (the form is in, the checkout opens). Meta's Sales
 * objective cannot optimise on Lead, and a €39 product at €20 a day never
 * reaches the 50 Purchases a week the learning phase wants, so the ad set
 * optimises on this step instead. Same shape as fireBrowserLead: the init
 * with user data is the Lead's job and is not repeated here. Never throws.
 */
export function fireBrowserInitiateCheckout({ eventId, value, currency, contentName, fbq } = {}) {
  const f = fbq || (typeof window !== 'undefined' ? window.fbq : undefined)
  if (typeof f !== 'function' || !eventId) return false
  try {
    const params = {}
    if (Number.isFinite(value)) params.value = value
    if (currency) params.currency = String(currency).toUpperCase()
    if (contentName) params.content_name = contentName
    f('track', 'InitiateCheckout', params, { eventID: eventId })
    return true
  } catch { return false }
}
