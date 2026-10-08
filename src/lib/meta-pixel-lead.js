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
