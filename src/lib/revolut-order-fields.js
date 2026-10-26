// REVPAY.7 — pure helpers that shape the optional fields of a Revolut order.
// Kept out of revolut.js so callers can use the duration helpers without
// importing the transport (and so tests that mock the transport keep them).
//
// Limits are from Order-Creation-v6 in merchant-2026-03-12 (POST /api/orders):
//   customer.email   string, format email        customer.full_name  string
//   customer.phone   string, E.164               customer.id         uuid (existing customer)
//   merchant_order_data.reference  string, no stated limit
//   statement_descriptor_suffix    string, minLength 1, maxLength 19, pattern ^[^*\n\r\\]+$
//   expire_pending_after           string, format duration (ISO 8601), PT1M..PT720H, not negative
// A bad optional value is DROPPED (never sent, never thrown): losing a nicety
// must not lose a payment.

/** Default pending expiry for a checkout a person is sitting at (spec range PT1M..PT720H). */
export const DEFAULT_EXPIRE_PENDING_AFTER = 'PT30M'
const EXPIRE_MIN_SECONDS = 60
const EXPIRE_MAX_SECONDS = 720 * 3600
const DESCRIPTOR_MAX = 19

/** ISO 8601 duration for a number of seconds, clamped to the spec's PT1M..PT720H. */
export function isoDurationFromSeconds(seconds) {
  const s = Math.min(EXPIRE_MAX_SECONDS, Math.max(EXPIRE_MIN_SECONDS, Math.ceil(Number(seconds) || 0)))
  let h = Math.floor(s / 3600)
  let m = Math.ceil((s - h * 3600) / 60)
  if (m === 60) { h += 1; m = 0 }
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}`
}

/** ISO 8601 duration for a number of hours (clamped like isoDurationFromSeconds). */
export function isoDurationFromHours(hours) {
  return isoDurationFromSeconds(Number(hours) * 3600)
}

/**
 * Validate an ISO 8601 duration (days/hours/minutes/seconds only) and clamp it
 * to the spec's range. Returns null when it does not parse.
 */
export function normaliseExpirePendingAfter(raw) {
  if (typeof raw !== 'string') return null
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(raw.trim().toUpperCase())
  if (!m) return null
  const total = (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)
  if (!(total > 0)) return null
  return isoDurationFromSeconds(total)
}

/** Statement suffix: printable ASCII, no `*`, upper case, 1..19 chars; null when nothing is left. */
export function sanitiseStatementDescriptorSuffix(raw) {
  if (raw == null) return null
  const cleaned = String(raw)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .,&'/#+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DESCRIPTOR_MAX)
    .trim()
  return cleaned || null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const E164_RE = /^\+[1-9]\d{6,14}$/

/** The `customer` object for an order, or null when nothing valid was given. */
export function buildCustomer(customer) {
  if (!customer || typeof customer !== 'object') return null
  const out = {}
  const email = typeof customer.email === 'string' ? customer.email.trim() : ''
  if (email && email.length <= 254 && EMAIL_RE.test(email)) out.email = email
  const fullName = typeof customer.fullName === 'string' ? customer.fullName.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  if (fullName) out.full_name = fullName
  const phone = typeof customer.phone === 'string' ? customer.phone.replace(/[\s()-]/g, '') : ''
  if (phone && E164_RE.test(phone)) out.phone = phone
  return Object.keys(out).length > 0 ? out : null
}
