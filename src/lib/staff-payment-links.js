// PAYLINK.1 — staff-sent un1t.online payment links (Hatch Street).
//
// A staff member sends a customer a link on WhatsApp; the customer opens
// /buy/<token>, accepts the terms themselves and pays on un1t.online's hosted
// checkout. The CRM never charges a card. This module is the ledger for
// `staff_payment_links` (mig 841): mint/hash the token, issue (revoking the
// previous live link), resolve a token, and the "was it paid" rule.
//
// The token is never stored or logged: only its sha256 hex. Every reader here
// is a service-role caller that enforces access itself (RLS does not bind it).

import crypto from 'node:crypto'
import { un1tPriceLabel } from '@/lib/agent/un1t-tools'
import { logWarn } from '@/lib/log'

export const STAFF_PAYMENT_LINK_TTL_MS = 7 * 24 * 60 * 60_000
export const LIVE_STATUSES = Object.freeze(['sent', 'opened', 'checkout_started'])
export const BUY_PATH = '/buy/'

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{40,64}$/
const LINK_COLUMNS = 'id, location_id, organization_id, contact_id, un1t_product_id, product_title, price_cents, status, un1t_user_id, terms_accepted_at, checkout_count, last_checkout_ledger_id, paid_transaction_id, paid_at, opened_at, whatsapp_message_id, last_error, created_by, created_at, expires_at'

export function hashPaymentToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

export function mintPaymentToken() {
  const token = crypto.randomBytes(32).toString('base64url')
  return { token, hash: hashPaymentToken(token) }
}

export function buildBuyUrl(baseUrl, token) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}${BUY_PATH}${token}`
}

async function revokeLive(db, { locationId, contactId, now }) {
  const { error } = await db.from('staff_payment_links')
    .update({ status: 'revoked', last_error: 'replaced by a newer link', updated_at: now })
    .eq('location_id', locationId)
    .eq('contact_id', contactId)
    .in('status', LIVE_STATUSES)
  return error || null
}

/**
 * Revoke any live link for (studio, contact), then insert the new one. The
 * partial unique index refuses a racing second live row (23505): revoke again
 * once and retry.
 * @returns {Promise<{ok:true, linkId:string, token:string, expiresAt:string}|{ok:false, error:string}>}
 */
export async function issueStaffPaymentLink(db, { locationId, organizationId, contactId, product, createdBy = null, now = Date.now() }) {
  const { token, hash } = mintPaymentToken()
  const createdAt = new Date(now).toISOString()
  const expiresAt = new Date(now + STAFF_PAYMENT_LINK_TTL_MS).toISOString()
  const row = {
    location_id: locationId,
    organization_id: organizationId,
    contact_id: contactId,
    un1t_product_id: product.un1t_id,
    product_title: product.title ?? null,
    price_cents: product.price_cents ?? null,
    token_hash: hash,
    status: 'sent',
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt,
    expires_at: expiresAt,
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const revokeError = await revokeLive(db, { locationId, contactId, now: createdAt })
    if (revokeError) {
      logWarn('paylink', 'revoke of the previous link failed', { contactId, locationId, error: revokeError.message })
      return { ok: false, error: revokeError.message || 'revoke failed' }
    }
    const { data, error } = await db.from('staff_payment_links').insert(row).select('id').single()
    if (!error) return { ok: true, linkId: data.id, token, expiresAt }
    if (error.code === '23505' && attempt === 0) continue
    logWarn('paylink', 'link insert failed', { contactId, locationId, code: error.code, error: error.message })
    return { ok: false, error: error.message || 'insert failed' }
  }
  return { ok: false, error: 'insert failed' }
}

export async function revokeStaffPaymentLink(db, linkId, reason = null) {
  const { error } = await db.from('staff_payment_links')
    .update({ status: 'revoked', last_error: reason, updated_at: new Date().toISOString() })
    .eq('id', linkId)
  if (error) logWarn('paylink', 'revoke failed', { linkId, error: error.message })
}

/**
 * Token → { kind:'not_found' } | { kind:'link', link, state }. A malformed
 * token never reaches the database. A live row past expires_at reads as
 * 'expired' without a write (the sweep stamps it). A read error throws: it is
 * never "not found" (the caller shows 'unavailable').
 */
export async function resolveStaffPaymentLink(db, token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return { kind: 'not_found' }
  const { data, error } = await db.from('staff_payment_links')
    .select(LINK_COLUMNS)
    .eq('token_hash', hashPaymentToken(token))
    .maybeSingle()
  if (error) throw new Error(`paylink resolve failed: ${error.message}`)
  if (!data) return { kind: 'not_found' }
  let state
  if (data.status === 'paid') state = 'paid'
  else if (data.status === 'revoked') state = 'revoked'
  else if (data.status === 'expired') state = 'expired'
  else {
    const exp = Date.parse(data.expires_at || '')
    state = !Number.isFinite(exp) || exp <= now ? 'expired' : 'live'
  }
  return { kind: 'link', link: data, state }
}

/** First open only: sent → opened. */
export async function markOpened(db, linkId, nowIso = new Date().toISOString()) {
  const { error } = await db.from('staff_payment_links')
    .update({ status: 'opened', opened_at: nowIso, updated_at: nowIso })
    .eq('id', linkId)
    .eq('status', 'sent')
  if (error) logWarn('paylink', 'markOpened failed', { linkId, error: error.message })
}

/**
 * Does this un1t_transactions row pay this link? Same person, same product,
 * made after the link, a real charge (not €0, not a subscription renewal, not
 * refunded). A transaction with no product never counts. Pure.
 */
export function isPaymentForLink(link, t) {
  if (!link || !t) return false
  if (!link.un1t_user_id || !link.un1t_product_id) return false
  if (t.un1t_user_id !== link.un1t_user_id) return false
  if (!t.product_id || t.product_id !== link.un1t_product_id) return false
  const at = Date.parse(t.remote_created_at || '')
  const since = Date.parse(link.created_at || '')
  if (!Number.isFinite(at) || !Number.isFinite(since) || at < since) return false
  if (!(Number(t.amount_cents) > 0)) return false
  if (t.type === 'sub_renewal') return false
  if (t.refunded === true) return false
  return true
}

/** "<title>, €125" / "<title>, €189 a month" (interval only for a recurring product). */
export function productLabel(product) {
  const recurring = product?.type === 'recurring'
  const price = un1tPriceLabel({
    price_cents: product?.price_cents,
    currency: product?.currency || 'EUR',
    billing_interval: recurring ? product?.billing_interval : null,
    billing_interval_count: recurring ? product?.billing_interval_count : null,
  })
  const title = String(product?.title || '').trim()
  return price ? (title ? `${title}, ${price}` : price) : title
}

export const COPY_DEFAULTS = Object.freeze({
  whatsapp_text: "Hi {first_name}, it's {studio}. Here's the link for the {product} we talked about on the phone. Tap below to pay securely on un1t.online.",
  button_text: 'Pay now',
  page_title_new: 'Complete your purchase',
  page_title_existing: 'Complete your purchase',
  paid_text: "You're all paid up. See you in class!",
  expired_text: "This link has expired. Reply to us on WhatsApp and we'll send you a new one.",
  unavailable_text: "We couldn't reach the payment system just now. Please try again in a minute.",
  help_text: "We couldn't set up your account automatically. Reply to us on WhatsApp and we'll sort it out.",
})

/** `locations.settings.un1t_online.payment_link` over the code defaults, per key. */
export function paymentLinkCopy(settings) {
  const s = settings && typeof settings === 'object' ? settings : {}
  const pick = (key) => (typeof s[key] === 'string' && s[key].trim() ? s[key] : COPY_DEFAULTS[key])
  const template = typeof s.template_name === 'string' && s.template_name.trim() ? s.template_name.trim() : null
  return {
    template_name: template,
    whatsapp_text: pick('whatsapp_text'),
    button_text: pick('button_text'),
    page_title_new: pick('page_title_new'),
    page_title_existing: pick('page_title_existing'),
    paid_text: pick('paid_text'),
    expired_text: pick('expired_text'),
    unavailable_text: pick('unavailable_text'),
    help_text: pick('help_text'),
  }
}
