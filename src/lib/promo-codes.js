// Event checkout discount codes (EVENTS-PROMO.1). Pure validation + discount
// maths (unit-tested); the DB load + redemption-count increment live in the
// public register route (the only caller that applies a code).

/** Canonical form for storage + lookup: trimmed, uppercased. */
export function normalizeCode(code) {
  return String(code || '').trim().toUpperCase()
}

/**
 * Cents off a given order total. Percent → floor(order × value%); fixed →
 * value cents. Never negative, never more than the order (a discount can zero
 * an order but not create a credit). `code` is a promo_codes row.
 */
export function computeDiscountCents(code, orderCents) {
  const order = Math.max(0, Math.trunc(Number(orderCents) || 0))
  if (!code || order === 0) return 0
  let d = 0
  if (code.discount_type === 'percent') {
    d = Math.floor((order * (Number(code.discount_value) || 0)) / 100)
  } else if (code.discount_type === 'fixed') {
    d = Math.trunc(Number(code.discount_value) || 0)
  }
  return Math.max(0, Math.min(d, order))
}

/**
 * Returns null when the code may be applied, else a customer-facing reason.
 * The redemption CAP is also enforced atomically at claim time in the route —
 * this is the pre-check for a clean error message.
 * @param {object} code  promo_codes row (already loaded for this location)
 * @param {{eventId?:string, nowMs?:number, isMemberOrder?:boolean}} ctx
 */
export function promoCodeError(code, { eventId, nowMs = Date.now(), isMemberOrder = false } = {}) {
  if (!code) return 'That code isn’t valid.'
  if (!code.active) return 'That code is no longer active.'
  if (code.expires_at && new Date(code.expires_at).getTime() < nowMs) return 'That code has expired.'
  if (code.event_id && code.event_id !== eventId) return 'That code doesn’t apply to this event.'
  if (code.member_only && !isMemberOrder) return 'That code is for members only.'
  if (code.max_redemptions != null && Number(code.redeemed_count) >= Number(code.max_redemptions)) {
    return 'That code has reached its limit.'
  }
  return null
}
