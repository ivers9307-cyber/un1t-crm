// MIAHATCH.6 (Task 19) — what Mia can sell at a un1t.online studio (Hatch
// Street), the purchase intent behind each payment link, and the hosted
// un1t.online checkout (spec 6.5, 6.5.1, 6.6; D's createCheckoutLink).
//
// Reached only in tool block 3b (`un1t_full`: WhatsApp, the studio's
// writes_enabled and its Mia switch), after refuseToolForTurn has passed;
// auto-reply.js loads this file lazily, so no other turn imports the write side.
//
// ONE LIVE LINK PER MEMBER. mia_purchase_intents_one_live (mig 752) is a
// partial unique index on (location_id, un1t_user_id) WHERE status =
// 'link_sent'. sendPurchaseLink reads the live intent first; a concurrent turn
// (or a retry) that inserts between that read and our insert makes our insert
// fail 23505, and that is read as "a live intent exists" (Review Focus 1): the
// live row is read again and the same rules apply. Same product: its stored
// link is resent (or, with none stored yet, D's createCheckoutLink again with
// the SAME idempotency key, the intent id).
// Different product: purchase_link_open_text, no second link. Never a tool
// error, never a second live link.
//
// The pay-done token (spec 6.5.2) is 32 random bytes, base64url, in the
// success and cancel URLs on the studio's customer host
// (resolveCustomerBaseUrl, which D checks: https on exactly that host). Only
// its sha256 hex is stored. A same-product resend (Ruling 30) sends the link
// the intent already holds, with no call to D; only an intent with no stored
// link asks D again (same key), and then stores the link with the hash of the
// token minted for that call.
//
// The checkout URL is stored on the intent and returned to the model, and is
// NEVER logged. Every log line is module 'mia-un1t' with codes only.
//
// free: true (un1t.online answered the checkout as free) means the product is
// on the account already. Task 21's settlePurchaseIntent is not built yet, so
// this settles the intent the simplest honest way: link_sent -> paid by the
// same status guard every detector uses, detected_by 'checkout_free'. Task 21
// routes it through settle (and books the class).
//
// check_my_purchase: until Task 21's member check exists it answers from a
// read of the live intent only, and never says paid.
//
// Every supabase read and write judges `error`; every intent write stamps
// updated_at (mig 752 has no trigger).
import { createHash, randomBytes } from 'node:crypto'
import { createCheckoutLink } from '@/lib/un1t-online-write-ops'
import { Un1tWriteRefused, Un1tWriteUnknown } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { logError, logWarn } from '@/lib/log'
import { DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT } from './notify'
import { UN1T_RETRY_CODES, actionSettings, executingContactOf, classTimeLabel, relayedStartMatches } from './un1t-action-studio'
import { renderMiaCopy } from './mia-copy'
import { isSellableUn1tProduct } from './mia-offer-limits'
import { parseAgentId } from './studio-ids'
import { TOOL_NOT_AT_THIS_STUDIO, refuseToolForTurn } from './tool-capability'
import { fetchLiveEntitlement } from './un1t-member-read'
import { un1tPriceLabel, zoneFor } from './un1t-tools'

const LOG_MODULE = 'mia-un1t'
const PROVIDER = 'un1t_online'
const INTENTS = 'mia_purchase_intents'
const LIVE = 'link_sent'

/** A live intent lives 23h, inside the WhatsApp customer-service window. */
export const PURCHASE_INTENT_TTL_MS = 23 * 60 * 60_000
/** Reserved for the free trial (Task 20); refused here. */
export const TRIAL_OFFER_ID = 'trial'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PRODUCT_COLS = 'id, un1t_id, title, status, price_cents, currency, billing_interval, billing_interval_count, credits_per_period'
const INTENT_COLS = 'id, un1t_product_id, product_title, class_name, class_time, checkout_url, expires_at'

// ── pure ────────────────────────────────────────────────────────────

/**
 * '€125' for a one-off, '€189 a month' / '€500 every 3 months' for a
 * recurring price; null with no price. Pure.
 */
export function formatPriceLabel({ priceCents, interval = null, intervalCount = null, currency = 'EUR' } = {}) {
  return un1tPriceLabel({ price_cents: priceCents, currency, billing_interval: interval, billing_interval_count: intervalCount })
}

/** sha256 hex of a pay-done token (what the intent stores). Pure. */
export function hashPayDoneToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

/** A fresh pay-done token (32 random bytes, base64url) and its hash. */
export function mintPayDoneToken() {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashPayDoneToken(token) }
}

const priceLabelOf = (p) => formatPriceLabel({
  priceCents: p?.price_cents, interval: p?.billing_interval, intervalCount: p?.billing_interval_count, currency: p?.currency || 'EUR',
})
const classLine = (name, time) => [name, time].map((v) => String(v || '').trim()).filter(Boolean).join(', ')

// ── answers the model reads ─────────────────────────────────────────

const NOT_VERIFIED = Object.freeze({ error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' })
const OFFER_NOT_AVAILABLE = Object.freeze({
  link_sent: false,
  error: 'offer_not_available',
  message: 'That offer is not available to buy from chat, so no link was made. Call list_purchase_options and offer only what it lists, or hand off to the team.',
})
const TRY_AGAIN = Object.freeze({
  link_sent: false,
  try_again: true,
  message: 'The payment link could not be made just now, so no link was sent and nothing was charged. Ask them to try again in a few minutes, or offer to hand off to the team. Never send or invent a link.',
})
const CLASS_TIME_MISMATCH = Object.freeze({
  link_sent: false,
  error: 'class_time_mismatch',
  message: 'The class time you passed does not match that class, so no link was made. Call list_upcoming_classes again, confirm the class and its day and time with the customer, and pass its event_id and starts_at exactly as listed. Or leave the class out if they only want to buy.',
})
const NOT_LINKED = Object.freeze({
  link_sent: false,
  not_linked: true,
  message: 'No account was found for this person at this studio, so no link was made. Offer to hand off to the team.',
})
const LINK_MESSAGE = 'Send the customer the wording, then end your message with the url on its own, with nothing after it and no tap choices, so it shows as a button. Never change the link. Never say they have paid: you will hear when the payment shows.'
const OPEN_MESSAGE = 'They already have a payment link open, so no new link was made. Relay the text. If they want something different, offer to hand off to the team.'

function handoffAnswer(settings) {
  const text = String(settings?.booking_issue_handoff_text || '').trim() || DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT
  return {
    link_sent: false,
    handoff: true,
    message: `The payment link could not be made, so no link was sent and nothing was charged. Tell the customer, staying close to this wording: "${text}", then hand off to the team. Never send or invent a link, and never say they have paid.`,
  }
}

// ── IO ──────────────────────────────────────────────────────────────

export class PurchaseOptionsReadError extends Error {
  constructor(message, { code = null } = {}) {
    super(message)
    this.name = 'PurchaseOptionsReadError'
    this.code = code
  }
}

/**
 * The studio's offers Mia may sell, in staff order (sort_order, then id): each
 * offer whose product is at this studio, active and priced above zero
 * (isSellableUn1tProduct, the same rule as the settings route; private
 * products included). The rest are skipped and counted.
 *
 * @param {object} db service-role client
 * @param {string} locationId the un1t.online studio
 * @returns {Promise<{ offers: Array<{ offer_id: string, title: string, price_label: string|null,
 *   credits: number|null, blurb: string|null }>, skipped: number }>}
 * @throws {PurchaseOptionsReadError} a read failed (never an empty list)
 */
export async function listPurchaseOptions(db, locationId) {
  const { data: rows, error } = await db.from('mia_purchase_offers')
    .select('id, un1t_product_row_id, blurb, sort_order')
    .eq('location_id', locationId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true })
  if (error) {
    logWarn(LOG_MODULE, 'offer list unreadable', { locationId, op: 'purchase_offers', status: null, code: error.code ?? null })
    throw new PurchaseOptionsReadError('mia_purchase_offers read failed', { code: error.code ?? null })
  }
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return { offers: [], skipped: 0 }

  const ids = [...new Set(list.map((r) => r.un1t_product_row_id).filter(Boolean))]
  const { data: products, error: productsError } = await db.from('un1t_products')
    .select(PRODUCT_COLS)
    .eq('location_id', locationId)
    .in('id', ids)
  if (productsError) {
    logWarn(LOG_MODULE, 'offer products unreadable', { locationId, op: 'purchase_offer_products', status: null, code: productsError.code ?? null })
    throw new PurchaseOptionsReadError('un1t_products read failed', { code: productsError.code ?? null })
  }
  const byId = new Map((Array.isArray(products) ? products : []).map((p) => [p.id, p]))

  const offers = []
  let skipped = 0
  for (const row of list) {
    const p = byId.get(row.un1t_product_row_id)
    if (!isSellableUn1tProduct(p)) {
      skipped++
      continue
    }
    offers.push({
      offer_id: row.id,
      title: String(p.title || '').trim() || 'Untitled product',
      price_label: priceLabelOf(p),
      credits: Number.isInteger(p.credits_per_period) ? p.credits_per_period : null,
      blurb: String(row.blurb || '').trim() || null,
    })
  }
  return { offers, skipped }
}

/** book_class's offer list (un1t-booking.js's default `offersFor`); the trial is Task 20's. */
export async function offersForBooking(ctx, studio) {
  const { offers } = await listPurchaseOptions(ctx.db, studio.locationId)
  return { offers, trial_available: false }
}

/** The offer's product at the studio: { product }, { unavailable: true } or { error: true }. */
async function readOfferProduct(db, studio, offerId) {
  const { data: offer, error } = await db.from('mia_purchase_offers')
    .select('id, un1t_product_row_id')
    .eq('location_id', studio.locationId)
    .eq('id', offerId)
    .maybeSingle()
  if (error) {
    logWarn(LOG_MODULE, 'offer unreadable', { locationId: studio.locationId, op: 'purchase_offer', status: null, code: error.code ?? null })
    return { error: true }
  }
  if (!offer) return { unavailable: true }
  const { data: product, error: productError } = await db.from('un1t_products')
    .select(PRODUCT_COLS)
    .eq('location_id', studio.locationId)
    .eq('id', offer.un1t_product_row_id)
    .maybeSingle()
  if (productError) {
    logWarn(LOG_MODULE, 'offer product unreadable', { locationId: studio.locationId, op: 'purchase_offer_product', status: null, code: productError.code ?? null })
    return { error: true }
  }
  if (!isSellableUn1tProduct(product) || !product.un1t_id) return { unavailable: true }
  return { product }
}

/** The member's live intent at the studio: { intent } (null when none) or { error: true }. */
async function readLiveIntent(db, studio, cols = INTENT_COLS) {
  const { data, error } = await db.from(INTENTS)
    .select(cols)
    .eq('location_id', studio.locationId)
    .eq('un1t_user_id', String(studio.un1tUserId))
    .eq('status', LIVE)
    .limit(1)
    .maybeSingle()
  if (error) {
    logWarn(LOG_MODULE, 'live intent unreadable', { locationId: studio.locationId, op: 'purchase_intent_read', status: null, code: error.code ?? null })
    return { error: true }
  }
  return { intent: data ?? null }
}

/**
 * Move a LIVE intent on: the update applies only while it is still link_sent
 * (the guard every detector shares), and stamps updated_at. true when this
 * call moved it (or, with no status in the patch, wrote it).
 */
async function writeLiveIntent(db, studio, intentId, patch, op, nowMs) {
  try {
    const { data, error } = await db.from(INTENTS)
      .update({ ...patch, updated_at: new Date(nowMs).toISOString() })
      .eq('id', intentId)
      .eq('status', LIVE)
      .select('id')
    if (error) {
      logError(LOG_MODULE, 'intent write failed', { locationId: studio.locationId, op, intentId, status: null, code: error.code ?? null })
      return false
    }
    return Array.isArray(data) && data.length > 0
  } catch (err) {
    logError(LOG_MODULE, 'intent write threw', { locationId: studio.locationId, op, intentId, status: null, errClass: err?.name })
    return false
  }
}

/**
 * The class the member wanted, from the mirror when it holds it, else as
 * relayed. When the mirror holds it, the relayed starts_at must name it in the
 * studio's zone (relayedStartMatches, as book_class checks it; missing is no
 * match): otherwise { mismatch: true } and no link is made.
 */
async function classContext(ctx, studio, input) {
  const parsed = parseAgentId(input?.event_id)
  if (parsed?.provider !== PROVIDER) return { event_un1t_id: null, class_name: null, class_time: null, starts_at: null }
  const relayed = {
    event_un1t_id: parsed.id,
    class_name: String(input?.class_name || '').trim() || null,
    class_time: String(input?.class_time || '').trim() || null,
    starts_at: null,
  }
  const { data, error } = await ctx.db.from('un1t_events')
    .select('un1t_id, title, starts_at')
    .eq('location_id', studio.locationId)
    .eq('un1t_id', parsed.id)
    .maybeSingle()
  if (error) {
    logWarn(LOG_MODULE, 'class unreadable; intent keeps the relayed class', { locationId: studio.locationId, op: 'purchase_class', status: null, code: error.code ?? null })
    return relayed
  }
  const startsMs = Date.parse(data?.starts_at || '')
  if (!data || !Number.isFinite(startsMs)) return relayed
  const zone = await zoneFor(ctx, studio)
  if (!relayedStartMatches(data.starts_at, input?.starts_at, zone)) {
    logWarn(LOG_MODULE, 'relayed class time does not match the class; no link made', {
      locationId: studio.locationId, op: 'purchase_class', status: null, relayed: typeof input?.starts_at === 'string' ? 'given' : 'missing',
    })
    return { mismatch: true }
  }
  return {
    event_un1t_id: parsed.id,
    class_name: String(data.title || '').trim() || relayed.class_name,
    class_time: classTimeLabel(startsMs, zone),
    starts_at: new Date(startsMs).toISOString(),
  }
}

/** What the live entitlement looked like when the link was made (Task 21 compares against it). */
async function entitlementSnapshot(db, studio) {
  try {
    const ent = await fetchLiveEntitlement(db, { locationId: studio.locationId, un1tUserId: studio.un1tUserId })
    if (ent?.ok) {
      return { ok: true, balance: ent.balance ?? null, unlimited: ent.unlimited === true, live_subscription_ids: ent.liveSubscriptionIds || [] }
    }
    return { ok: false, reason: ent?.reason ?? 'read_failed' }
  } catch (err) {
    logWarn(LOG_MODULE, 'entitlement snapshot threw', { locationId: studio.locationId, op: 'purchase_snapshot', status: null, errClass: err?.name })
    return { ok: false, reason: 'read_failed' }
  }
}

/** The two pay-done URLs for a token on the studio's customer host. */
function payDoneUrls(base, token) {
  const successUrl = `${String(base).replace(/\/+$/, '')}/pay-done/${token}`
  return { successUrl, cancelUrl: `${successUrl}?c=1` }
}

const failureCode = (err) => err?.code ?? null
const failureLedgerId = (err) => err?.ledgerId ?? err?.result?.ledgerId ?? null
const isRetryable = (err) => err instanceof Un1tWriteRefused && (UN1T_RETRY_CODES.has(err.code) || err.result?.retryable === true)

/**
 * D's createCheckoutLink for an intent, and what it means:
 * { url } | { free: true } | { failed: err }.
 */
async function checkout(db, studio, intentId, productId, urls) {
  try {
    const out = await createCheckoutLink(db, {
      locationId: studio.locationId,
      userId: String(studio.un1tUserId),
      productId,
      successUrl: urls.successUrl,
      cancelUrl: urls.cancelUrl,
      idempotencyKey: intentId,
      origin: 'mia',
      originRef: intentId,
    })
    if (out?.free === true) return { free: true }
    if (typeof out?.checkoutUrl === 'string' && out.checkoutUrl) return { url: out.checkoutUrl }
    return { failed: Object.assign(new Error('checkout answered without a link'), { code: 'no_checkout_url' }) }
  } catch (err) {
    return { failed: err }
  }
}

function logCheckoutFailure(studio, intentId, err, op) {
  const known = err instanceof Un1tWriteRefused || err instanceof Un1tSettingsReadError
  const log = known ? logWarn : logError
  log(LOG_MODULE, 'payment link not made', {
    locationId: studio.locationId, op, intentId, status: null, code: failureCode(err), errClass: err?.name,
    unknown: err instanceof Un1tWriteUnknown,
  })
}

/** A checkout that did not give a link: the intent is refused (it frees the member), the team takes over. */
async function refuseIntent(db, studio, intentId, err, settings, nowMs) {
  await writeLiveIntent(db, studio, intentId, {
    status: 'refused',
    outcome: { stage: 'checkout', code: failureCode(err), error: err?.name ?? null },
    ...(failureLedgerId(err) ? { un1t_write_id: failureLedgerId(err) } : {}),
  }, 'purchase_refuse', nowMs)
  return handoffAnswer(settings)
}

/** free: true. The product is on the account already (see the header: Task 21 routes this through settle). */
async function settleFree(db, studio, intentId, product, nowMs) {
  await writeLiveIntent(db, studio, intentId, {
    status: 'paid', detected_by: 'checkout_free', paid_detected_at: new Date(nowMs).toISOString(),
  }, 'purchase_free', nowMs)
  return {
    link_sent: false,
    paid: true,
    product,
    intent_id: intentId,
    message: `un1t.online answered ${product} as free, so there is nothing to pay and it is on their account now. Tell them so. If they wanted a class, offer to book it now with book_class.`,
  }
}

function linkAnswer(url, { product, priceLabel, className, classTime, intentId }, settings) {
  return {
    link_sent: true,
    url,
    product,
    price_label: priceLabel,
    wording: renderMiaCopy('purchase_link_text', settings, { product, class: classLine(className, classTime) || null }),
    intent_id: intentId,
    message: LINK_MESSAGE,
  }
}

function openAnswer(intent, settings) {
  const product = String(intent.product_title || '').trim() || 'your purchase'
  return {
    link_sent: false,
    link_open: true,
    product,
    text: renderMiaCopy('purchase_link_open_text', settings, { product }),
    intent_id: intent.id,
    message: OPEN_MESSAGE,
  }
}

/**
 * The member already has a live intent. Different product: the open text.
 * Same product (Ruling 30): the link it already holds is resent as it is, with
 * no call to D (the same hosted session; nothing to refuse or doubt). Only an
 * intent with no stored link (an earlier store failed, or another turn is
 * still sending) asks D again with the intent's own key; a URL that comes back
 * is stored with the hash of the token minted for that call. Nothing was ever
 * delivered for such an intent, so a non-retryable failure may refuse it; a
 * retryable one (another turn mid-send) leaves it live.
 */
async function answerLiveIntent(ctx, studio, intent, product, settings, nowMs, base) {
  const db = ctx.db
  if (String(intent.un1t_product_id) !== String(product.un1t_id)) return openAnswer(intent, settings)
  const title = String(intent.product_title || '').trim() || String(product.title || '').trim()
  const answer = (url) => linkAnswer(url, { product: title, priceLabel: priceLabelOf(product), className: intent.class_name, classTime: intent.class_time, intentId: intent.id }, settings)
  if (typeof intent.checkout_url === 'string' && intent.checkout_url) return answer(intent.checkout_url)

  let urls
  const { token, hash } = mintPayDoneToken()
  try {
    urls = payDoneUrls(base ?? await resolveCustomerBaseUrl(db, studio.locationId), token)
  } catch (err) {
    logError(LOG_MODULE, 'customer site unreadable; no link resent', { locationId: studio.locationId, op: 'purchase_resend', intentId: intent.id, status: null, errClass: err?.name })
    return { ...TRY_AGAIN }
  }
  const out = await checkout(db, studio, intent.id, product.un1t_id, urls)
  if (out.failed) {
    logCheckoutFailure(studio, intent.id, out.failed, 'purchase_resend')
    if (isRetryable(out.failed)) return { ...TRY_AGAIN }
    return refuseIntent(db, studio, intent.id, out.failed, settings, nowMs)
  }
  if (out.free) return settleFree(db, studio, intent.id, title, nowMs)
  const stored = await writeLiveIntent(db, studio, intent.id, { checkout_url: out.url, success_token_hash: hash }, 'purchase_store_link', nowMs)
  // Still sent: the member can pay, and detection reads the entitlement, not the URL.
  if (!stored) logError(LOG_MODULE, 'payment link not stored on the intent', { locationId: studio.locationId, op: 'purchase_store_link', intentId: intent.id, status: null })
  return answer(out.url)
}

/**
 * send_purchase_link at one un1t.online studio (see the header for the rules).
 *
 * @param {object} ctx tool context (db, verifiedContactId, locationId, zone,
 *   settings, actionStudio, channel, conversationId)
 * @param {{ offer_id: string, event_id?: string, class_name?: string, class_time?: string, starts_at?: string }} input
 * @param {import('./member-studios').MemberStudio} studio the answerable un1t.online studio
 * @param {{ now?: () => number }} [deps]
 * @returns {Promise<object>} one of { link_sent: true, url, product, price_label, wording, intent_id },
 *   { link_sent: false, link_open: true, product, text, intent_id }, { link_sent: false, paid: true, product, intent_id },
 *   { link_sent: false, handoff: true }, { link_sent: false, try_again: true },
 *   { link_sent: false, error: 'offer_not_available' }, { link_sent: false, not_linked: true }, { error: 'not_verified' }
 */
export async function sendPurchaseLink(ctx, input, studio, deps = {}) {
  const { now = () => Date.now() } = deps
  const db = ctx?.db
  if (!ctx?.verifiedContactId) return { ...NOT_VERIFIED }
  if (!studio || studio.providerKey !== PROVIDER) return { ...TOOL_NOT_AT_THIS_STUDIO }
  if (!studio.un1tUserId) return { ...NOT_LINKED }
  const offerId = typeof input?.offer_id === 'string' ? input.offer_id.trim() : ''
  // 'trial' is Task 20's (the free trial goes through D's grantTrial, never checkout).
  if (offerId === TRIAL_OFFER_ID || !UUID.test(offerId)) return { ...OFFER_NOT_AVAILABLE }

  const settings = await actionSettings(ctx, studio)
  const resolved = await readOfferProduct(db, studio, offerId)
  if (resolved.error) return { ...TRY_AGAIN }
  if (resolved.unavailable) return { ...OFFER_NOT_AVAILABLE }
  const { product } = resolved
  const nowMs = now()

  // 1 a live intent already?
  const live = await readLiveIntent(db, studio)
  if (live.error) return { ...TRY_AGAIN }
  if (live.intent) {
    const expiresMs = Date.parse(live.intent.expires_at || '')
    if (Number.isFinite(expiresMs) && expiresMs <= nowMs) {
      // Past its 23h: expire it quietly (the post-sync sweep would), which frees the member.
      await writeLiveIntent(db, studio, live.intent.id, { status: 'expired' }, 'purchase_expire', nowMs)
      const again = await readLiveIntent(db, studio)
      if (again.error) return { ...TRY_AGAIN }
      if (again.intent) return answerLiveIntent(ctx, studio, again.intent, product, settings, nowMs)
    } else {
      return answerLiveIntent(ctx, studio, live.intent, product, settings, nowMs)
    }
  }

  // 2 a new intent: everything it needs is read before it is written.
  let base
  try {
    base = await resolveCustomerBaseUrl(db, studio.locationId)
  } catch (err) {
    logError(LOG_MODULE, 'customer site unreadable; no link made', { locationId: studio.locationId, op: 'purchase_new', status: null, errClass: err?.name })
    return handoffAnswer(settings)
  }
  const { data: loc, error: locError } = await db.from('locations').select('organization_id').eq('id', studio.locationId).maybeSingle()
  if (locError || !loc?.organization_id) {
    logWarn(LOG_MODULE, 'studio organisation unreadable; no link made', { locationId: studio.locationId, op: 'purchase_new', status: null, code: locError?.code ?? null })
    return { ...TRY_AGAIN }
  }
  const klass = await classContext(ctx, studio, input)
  if (klass.mismatch) return { ...CLASS_TIME_MISMATCH }
  const snapshot = await entitlementSnapshot(db, studio)
  const { token, hash } = mintPayDoneToken()
  const createdAt = new Date(nowMs).toISOString()
  const title = String(product.title || '').trim() || 'Untitled product'

  const { data: inserted, error: insertError } = await db.from(INTENTS).insert({
    location_id: studio.locationId,
    organization_id: loc.organization_id,
    contact_id: executingContactOf(ctx, studio),
    conversation_id: ctx.conversationId || null,
    channel: ctx.channel || 'whatsapp',
    un1t_user_id: String(studio.un1tUserId),
    un1t_product_id: String(product.un1t_id),
    product_title: title,
    price_cents: product.price_cents,
    ...klass,
    success_token_hash: hash,
    status: LIVE,
    entitlement_snapshot: snapshot,
    created_at: createdAt,
    expires_at: new Date(nowMs + PURCHASE_INTENT_TTL_MS).toISOString(),
    updated_at: createdAt,
  }).select('id').single()

  if (insertError?.code === '23505') {
    // Review Focus 1: another turn made the live intent first. Its rules, never an error.
    const raced = await readLiveIntent(db, studio)
    if (raced.error || !raced.intent) return { ...TRY_AGAIN }
    return answerLiveIntent(ctx, studio, raced.intent, product, settings, nowMs, base)
  }
  if (insertError || !inserted?.id) {
    logError(LOG_MODULE, 'intent not written; no link made', { locationId: studio.locationId, op: 'purchase_new', status: null, code: insertError?.code ?? null })
    return { ...TRY_AGAIN }
  }
  const intentId = inserted.id

  // 3 D's hosted checkout, keyed on the intent.
  const out = await checkout(db, studio, intentId, String(product.un1t_id), payDoneUrls(base, token))
  if (out.failed) {
    logCheckoutFailure(studio, intentId, out.failed, 'purchase_new')
    return refuseIntent(db, studio, intentId, out.failed, settings, nowMs)
  }
  if (out.free) return settleFree(db, studio, intentId, title, nowMs)

  const stored = await writeLiveIntent(db, studio, intentId, { checkout_url: out.url }, 'purchase_store_link', nowMs)
  // Still sent: the member can pay, and detection reads the entitlement, not the URL.
  if (!stored) logError(LOG_MODULE, 'payment link not stored on the intent', { locationId: studio.locationId, op: 'purchase_store_link', intentId, status: null })
  return linkAnswer(out.url, { product: title, priceLabel: priceLabelOf(product), className: klass.class_name, classTime: klass.class_time, intentId }, settings)
}

/**
 * check_my_purchase until Task 21's member check: whether a link is open, from
 * a read of the live intent. Never says paid.
 */
export async function checkMyPurchase(ctx, studio) {
  if (!ctx?.verifiedContactId) return { ...NOT_VERIFIED }
  if (!studio?.un1tUserId) return { paid: false, open_link: false, message: NOT_LINKED.message }
  const live = await readLiveIntent(ctx.db, studio, 'id, product_title')
  if (live.error) {
    return {
      paid: false,
      error: 'purchase_unreadable',
      message: 'Their payment could not be checked just now. Never say it has or has not gone through: say a payment can take a few minutes to show, and offer to hand off to the team.',
    }
  }
  if (!live.intent) {
    return {
      paid: false,
      open_link: false,
      message: 'No payment link is open for them. Never say a payment has gone through. If they say they have paid, say it can take a few minutes to show, and offer to hand off to the team.',
    }
  }
  const product = String(live.intent.product_title || '').trim() || 'their purchase'
  return {
    paid: false,
    open_link: true,
    product,
    intent_id: live.intent.id,
    message: `Their payment link for ${product} is open and no payment has shown yet. A payment can take a few minutes to show, so never say it has gone through. If they say they have paid, say you will confirm as soon as it shows, or offer to hand off to the team.`,
  }
}

/** The answerable un1t.online studio a purchase tool runs at. */
const un1tStudioOf = (ctx) => (ctx?.turn?.answerable || []).find((s) => s?.providerKey === PROVIDER) || null

/**
 * The purchase tools' executor (auto-reply.js dispatches here, lazily).
 * Refused outside block 3b before any read.
 *
 * @param {'list_purchase_options'|'send_purchase_link'|'check_my_purchase'} toolName
 * @param {object} input
 * @param {object} ctx tool context
 */
export async function executePurchaseTool(toolName, input, ctx) {
  const refused = refuseToolForTurn(toolName, ctx)
  if (refused) return refused
  if (ctx?.turn?.block !== 'un1t_full') return { ...TOOL_NOT_AT_THIS_STUDIO }
  const studio = un1tStudioOf(ctx)
  if (!studio) return { ...TOOL_NOT_AT_THIS_STUDIO }

  if (toolName === 'send_purchase_link') return sendPurchaseLink(ctx, input, studio)
  if (toolName === 'check_my_purchase') return checkMyPurchase(ctx, studio)
  if (toolName !== 'list_purchase_options') return { ...TOOL_NOT_AT_THIS_STUDIO }

  let listed
  try {
    listed = await listPurchaseOptions(ctx.db, studio.locationId)
  } catch {
    return {
      error: 'offers_unreadable',
      message: 'The offers could not be read just now. Never invent an offer or a price: say you cannot check right now and offer to hand off to the team.',
    }
  }
  if (!listed.offers.length) {
    return {
      offers: [],
      trial_available: false,
      message: 'Nothing is set up to buy from chat at this studio. Never invent an offer or a price: hand off to the team.',
    }
  }
  const settings = await actionSettings(ctx, studio)
  return {
    offers: listed.offers,
    trial_available: false,
    wording: renderMiaCopy('purchase_offer_intro_text', settings, { studio: studio.name }),
    message: 'Introduce them with the wording. Give each title and price_label exactly as listed. With 3 or fewer offers, offer them as tap choices; with more, list them. Never offer anything that is not listed.',
  }
}
