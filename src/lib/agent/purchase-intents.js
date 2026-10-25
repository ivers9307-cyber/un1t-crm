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
// Different product: purchase_link_open_text, no second link, and the turn
// hands the thread to the team (open_link_handoff, MIAFIX.1). Never a tool
// error, never a second live link. A same-product request that names a
// different class moves the live intent to that class first (status-guarded on
// link_sent), and the link goes out with the new class's wording: the hosted
// payment is the same product, so the settle books the class asked for last.
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
// on the account already: the intent is settled at once through
// settlePurchaseIntent (detected_by 'tool', outcome.free), so its class is
// booked (or it ends no_class) and no row stays in the non-terminal 'paid'.
//
// SETTLE (Task 21): settlePurchaseIntent, check_my_purchase and the expiry
// sweep live in purchase-settle.js, which this module imports (never the
// reverse). A lapsed live intent is settled before it is expired, so a
// payment made inside its window is booked, never answered with a second link.
//
// THE FREE TRIAL (Task 20, spec R1): offered first, and only to an eligible
// member. trialAvailable asks A's trialEligibility (the reads seam) with the
// studio's trial_product_id configured, and fails closed: anything but
// `eligible === true` is no trial. It runs before the trial is offered
// (list_purchase_options, book_class's needs_purchase via offersForBooking);
// a read that FAILED offers nothing and files one class_booking card
// (un1t_trial_check_failed) with the booking issue handoff text. The trial is
// given by send_purchase_link({ offer_id: 'trial' }) through D's grantTrial
// only, never createCheckoutLink and never a purchase intent: with a class,
// Task 16's write-ahead class_booking row is written first (details.stage
// 'trial') and its id is the originRef; then granted runs Task 16's execute
// step on that row. ineligible is trial_used_text + the offers (grantTrial is
// not asked again that turn); needs_staff is one card with D's reason + the
// handoff text; retry is try-again wording, and a second retry in the same
// turn is the handoff text.
//
// Every supabase read and write judges `error`; every intent write stamps
// updated_at (mig 752 has no trigger).
import { createCheckoutLink, grantTrial } from '@/lib/un1t-online-write-ops'
import { Un1tWriteRefused, Un1tWriteUnknown } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError, readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { membershipReadsFor, supportsRead } from '@/lib/membership/reads'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { logError, logWarn } from '@/lib/log'
import { DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT } from './notify'
import { UN1T_RETRY_CODES, actionSettings, executingContactOf, classTimeLabel, relayedStartMatches } from './un1t-action-studio'
import { renderMiaCopy } from './mia-copy'
import { hashPayDoneToken, mintPayDoneToken } from './pay-done-token'
import { isSellableUn1tProduct } from './mia-offer-limits'
import { parseAgentId } from './studio-ids'
import { TOOL_NOT_AT_THIS_STUDIO, refuseToolForTurn } from './tool-capability'
import { fetchLiveEntitlement } from './un1t-member-read'
import { un1tPriceLabel, zoneFor } from './un1t-tools'
import {
  ALREADY_SETTLED, PAID_OUTCOMES, PAYMENT_PENDING, checkMyPurchase, paidAnswer, readMemberLiveIntent, settlePurchaseIntent,
} from './purchase-settle'
import {
  UN1T_TRIAL_CHECK_FAILED_LEAD, alertUn1tBookingCard, executeUn1tBook, fileUn1tBookingCard, finishUn1tBookingRow,
  insertUn1tBookingRow, prepareUn1tBooking,
} from './un1t-booking'

// The token helpers live in the leaf ./pay-done-token; re-exported for callers.
export { hashPayDoneToken, mintPayDoneToken }

const LOG_MODULE = 'mia-un1t'
const PROVIDER = 'un1t_online'
const INTENTS = 'mia_purchase_intents'
const LIVE = 'link_sent'

/** A live intent lives 23h, inside the WhatsApp customer-service window. */
export const PURCHASE_INTENT_TTL_MS = 23 * 60 * 60_000
/** The free trial's offer_id: D's grantTrial, never a checkout (Task 20). */
export const TRIAL_OFFER_ID = 'trial'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PRODUCT_COLS = 'id, un1t_id, title, type, status, price_cents, currency, billing_interval, billing_interval_count, credits_per_period'
const INTENT_COLS = 'id, un1t_product_id, product_title, event_un1t_id, class_name, class_time, checkout_url, expires_at'

// ── pure ────────────────────────────────────────────────────────────

/**
 * '€125' for a one-off, '€189 a month' / '€500 every 3 months' for a
 * recurring price; null with no price. Pure.
 */
export function formatPriceLabel({ priceCents, interval = null, intervalCount = null, currency = 'EUR' } = {}) {
  return un1tPriceLabel({ price_cents: priceCents, currency, billing_interval: interval, billing_interval_count: intervalCount })
}

// MIAFIX.1 — un1t_products keeps a billing_interval ('month') even on a
// one_time pack, so the interval wording ("a month", "every 3 months") is for
// type 'recurring' only; anything else is quoted as its price alone.
const priceLabelOf = (p) => {
  const recurring = p?.type === 'recurring'
  return formatPriceLabel({
    priceCents: p?.price_cents,
    interval: recurring ? p?.billing_interval : null,
    intervalCount: recurring ? p?.billing_interval_count : null,
    currency: p?.currency || 'EUR',
  })
}
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
// MIAFIX.1 (6) — a link open for a DIFFERENT product: the runner hands the
// thread to the team in this turn (open_link_handoff) and sends `text` as the
// customer's message, discarding the model's own reply.
const OPEN_MESSAGE = 'They already have a payment link open for another product, so no new link was made and the conversation is being handed to the team now. The customer is sent the text. Write nothing more.'

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

/**
 * May this member be offered the studio's free trial? Fails closed: available
 * only when the studio has a trial_product_id AND A's trialEligibility read
 * succeeded with `eligible === true`, or (TRIALREGRANT.1, Richard 20 Oct 2026)
 * with `regrant === true`: they claimed the trial, never used it and it ran
 * out, so the free class is offered again and D's grantTrial adds the credits
 * (it reads the live balance itself before sending anything). `regrant` is
 * true on that answer only. No trial_product_id: not available, no
 * reasons, A never asked. A read that failed (the studio's settings, the
 * reads seam, or A itself) is `readFailed`: the caller offers no trial and
 * files the un1t_trial_check_failed card.
 *
 * @param {object} db service-role client
 * @param {{ locationId: string, un1tUserId: string, contactId: string|null }} who
 * @returns {Promise<{ available: boolean, reasons: string[], regrant?: true, readFailed?: boolean }>}
 */
export async function trialAvailable(db, { locationId, un1tUserId, contactId = null } = {}) {
  const failed = (code, errClass = null) => {
    logWarn(LOG_MODULE, 'free trial eligibility unreadable; no trial offered', { locationId, op: 'trial_eligibility', status: null, code, errClass })
    return { available: false, reasons: [], readFailed: true }
  }
  let productId
  try {
    productId = (await readUn1tWriteSettings(db, locationId)).settings.trialProductId
  } catch (err) {
    return failed(err?.code ?? 'settings_unreadable', err?.name ?? null)
  }
  if (!productId) return { available: false, reasons: [] }
  let r
  try {
    const seam = await membershipReadsFor(db, locationId)
    if (!supportsRead(seam, 'trialEligibility')) return failed('eligibility_unsupported')
    r = await seam.reads.trialEligibility(db, locationId, { un1tUserId: String(un1tUserId), contactId })
  } catch (err) {
    return failed('eligibility_threw', err?.name ?? null)
  }
  if (r?.success !== true) return failed('eligibility_unreadable')
  const reasons = Array.isArray(r.data?.reasons) ? r.data.reasons.filter((x) => typeof x === 'string') : []
  if (r.data?.eligible !== true && r.data?.regrant === true) return { available: true, reasons, regrant: true }
  return { available: r.data?.eligible === true, reasons }
}

const trialWhoOf = (ctx, studio) => ({
  locationId: studio.locationId, un1tUserId: studio.un1tUserId, contactId: executingContactOf(ctx, studio),
})

/**
 * book_class's offer list (un1t-booking.js's default `offersFor`): the
 * studio's offers, and whether the free trial may be offered first.
 * `trial_check_failed` when the eligibility read failed (book_class then
 * files the card and hands off).
 * @throws {PurchaseOptionsReadError} the offers could not be read
 */
export async function offersForBooking(ctx, studio) {
  const { offers } = await listPurchaseOptions(ctx.db, studio.locationId)
  const trial = await trialAvailable(ctx.db, trialWhoOf(ctx, studio))
  if (trial.readFailed) return { offers, trial_available: false, trial_check_failed: true }
  return { offers, trial_available: trial.available }
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

/** The member's live intent at the studio, with this module's columns (purchase-settle.js reads it). */
const readLiveIntent = (db, studio, cols = INTENT_COLS) => readMemberLiveIntent(db, studio, cols)

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
 * { url, ledgerId } | { free: true, ledgerId } | { failed: err }. ledgerId is
 * the un1t_write_events row (null when D did not name one).
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
    const ledgerId = typeof out?.ledgerId === 'string' && out.ledgerId ? out.ledgerId : null
    if (out?.free === true) return { free: true, ledgerId }
    if (typeof out?.checkoutUrl === 'string' && out.checkoutUrl) return { url: out.checkoutUrl, ledgerId }
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

// MIAFIX.1 (5) — the checkout's ledger row on the intent: un1t_write_id.
const ledgerPatch = (out) => (out?.ledgerId ? { un1t_write_id: out.ledgerId } : {})

/**
 * free: true. The ledger id is written (link_sent-guarded, no status change)
 * before settlePurchaseIntent moves the intent on; a failed write is logged by
 * writeLiveIntent and never stops the settle.
 */
async function storeFreeLedger(db, studio, intentId, out, nowMs) {
  if (out?.ledgerId) await writeLiveIntent(db, studio, intentId, ledgerPatch(out), 'purchase_store_ledger', nowMs)
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

/**
 * free: true. The product is on the account already, so the intent is settled
 * at once (settlePurchaseIntent with free: the class booked, or no_class).
 */
async function settleFree(db, intentId, product, nowMs) {
  const settled = await settlePurchaseIntent(db, intentId, { detectedBy: 'tool', source: 'live', free: true, now: () => nowMs })
  if (PAID_OUTCOMES.has(settled.outcome)) return { ...paidAnswer(settled, product, intentId), link_sent: false }
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
    open_link_handoff: true,
    product,
    text: renderMiaCopy('purchase_link_open_text', settings, { product }),
    intent_id: intent.id,
    message: OPEN_MESSAGE,
  }
}

/** The statuses a live intent leaves for once a payment is picked up (purchase-settle.js). */
const SETTLED_STATUSES = new Set(['paid', 'booked', 'book_failed', 'no_class'])

/**
 * The class a same-product request asks the live intent to move to: null when
 * the input names no class or the intent's own; { mismatch: true } when the
 * relayed time does not name the class (classContext); else the new class.
 */
async function classSwitchOf(ctx, studio, intent, input) {
  if (parseAgentId(input?.event_id)?.provider !== PROVIDER) return null
  const klass = await classContext(ctx, studio, input)
  if (klass.mismatch) return klass
  if (!klass.event_un1t_id || String(klass.event_un1t_id) === String(intent.event_un1t_id || '')) return null
  return klass
}

/**
 * Move a live intent to the class the member now wants (same product, so the
 * hosted payment and its link stay valid): status-guarded on link_sent, so a
 * settle or expiry that got there first wins. { intent } (the moved intent)
 * on success; otherwise the answer for the state it is in now: settled is
 * ALREADY_SETTLED, still live (the write failed) or gone is try again, and a
 * different live intent (another turn) is answered by the same rules, once
 * (a second miss is try again).
 */
async function switchIntentClass(ctx, studio, intent, klass, product, settings, nowMs, base, input, retried) {
  const db = ctx.db
  const patch = { event_un1t_id: klass.event_un1t_id, class_name: klass.class_name, class_time: klass.class_time, starts_at: klass.starts_at }
  if (await writeLiveIntent(db, studio, intent.id, patch, 'purchase_switch_class', nowMs)) return { intent: { ...intent, ...patch } }
  const live = await readLiveIntent(db, studio)
  if (live.error) return { answer: { ...TRY_AGAIN } }
  if (live.intent && live.intent.id !== intent.id && !retried) {
    return { answer: await answerLiveIntent(ctx, studio, live.intent, product, settings, nowMs, base, input, { retried: true }) }
  }
  if (live.intent) return { answer: { ...TRY_AGAIN } }
  const { data, error } = await db.from(INTENTS).select('status').eq('id', intent.id).maybeSingle()
  if (error) {
    logWarn(LOG_MODULE, 'intent unreadable after a class switch missed', { locationId: studio.locationId, op: 'purchase_switch_class', intentId: intent.id, status: null, code: error.code ?? null })
    return { answer: { ...TRY_AGAIN } }
  }
  if (SETTLED_STATUSES.has(data?.status)) return { answer: { ...ALREADY_SETTLED, link_sent: false } }
  return { answer: { ...TRY_AGAIN } }
}

/**
 * The member already has a live intent. Different product: the open text.
 * Same product (Ruling 30): the link it already holds is resent as it is, with
 * no call to D (the same hosted session; nothing to refuse or doubt). When the
 * request names a different class (one classContext accepts), the intent moves
 * to it first (switchIntentClass) and the link goes with the new class's
 * wording, so the settle books the class the member asked for last; a request
 * with no class keeps the intent's class. Only an intent with no stored link
 * (an earlier store failed, or another turn is still sending) asks D again
 * with the intent's own key; a URL that comes back is stored with the hash of
 * the token minted for that call. Such an intent's first link MAY have been
 * delivered (a failed store still sends it), so a D failure never refuses it:
 * retryable is try again, anything else the handoff, and the intent stays live
 * so a payment on that first link still settles.
 */
async function answerLiveIntent(ctx, studio, intent, product, settings, nowMs, base, input = null, { retried = false } = {}) {
  const db = ctx.db
  if (String(intent.un1t_product_id) !== String(product.un1t_id)) return openAnswer(intent, settings)
  const klass = await classSwitchOf(ctx, studio, intent, input)
  if (klass?.mismatch) return { ...CLASS_TIME_MISMATCH }
  if (klass) {
    const moved = await switchIntentClass(ctx, studio, intent, klass, product, settings, nowMs, base, input, retried)
    if (moved.answer) return moved.answer
    intent = moved.intent
  }
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
    // Never refused: its first link may be with the member.
    return handoffAnswer(settings)
  }
  if (out.free) {
    await storeFreeLedger(db, studio, intent.id, out, nowMs)
    return settleFree(db, intent.id, title, nowMs)
  }
  const stored = await writeLiveIntent(db, studio, intent.id, { checkout_url: out.url, success_token_hash: hash, ...ledgerPatch(out) }, 'purchase_store_link', nowMs)
  // Still sent: the member can pay, and detection reads the entitlement, not the URL.
  if (!stored) logError(LOG_MODULE, 'payment link not stored on the intent', { locationId: studio.locationId, op: 'purchase_store_link', intentId: intent.id, status: null })
  return answer(out.url)
}

// ── the free trial (Task 20) ────────────────────────────────────────

const TRIAL_FIRST_MESSAGE = 'They can have the free trial: offer it first, before the paid offers. To give it, get a clear yes, then call send_purchase_link with offer_id "trial" (and the class, when they want one). Never say the trial is on their account until a tool says so.'
const NEVER_TRIAL_YET = 'Never say the trial is on their account or that a class is booked.'
// After D granted the trial: it is on their account whatever the booking said,
// and nothing is ever sold or offered on top of it.
const TRIAL_ON_ACCOUNT = 'The free trial is on their account now: tell them so. Never offer the free trial again and never offer anything to buy for this class; to try the class again, or book another, use book_class.'
const TRIAL_ALREADY_GRANTED = Object.freeze({
  link_sent: false,
  trial_granted: true,
  already_granted: true,
  message: 'The free trial is already on their account from earlier in this conversation, so nothing more was given. Never offer the trial or anything to buy for it: to book a class, use list_upcoming_classes, then book_class. Never say a class is booked until book_class says so.',
})

/**
 * Per turn: how many grantTrial retries, whether D said ineligible (then it is
 * not asked again), and whether D granted the trial (then a repeat trial call
 * gives nothing and offers nothing: the next step is book_class). Keyed on the tool context, which auto-reply.js builds
 * once per turn and hands the purchase tools as it is.
 */
const trialTurns = new WeakMap()
function trialTurnOf(ctx) {
  let state = trialTurns.get(ctx)
  if (!state) {
    state = { retries: 0, ineligible: false, granted: false }
    trialTurns.set(ctx, state)
  }
  return state
}

/** The handoff after a trial that could not be checked or given (never "granted", never "booked"). */
function trialHandoff(reason, settings, lead) {
  const text = String(settings?.booking_issue_handoff_text || '').trim() || DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT
  return {
    link_sent: false,
    booked: false,
    handoff: true,
    reason,
    message: `${lead} Tell the customer, staying close to this wording: "${text}", then hand off to the team. ${NEVER_TRIAL_YET}`,
  }
}
const TRIAL_LEAD = Object.freeze({
  check_failed: UN1T_TRIAL_CHECK_FAILED_LEAD,
  needs_staff: 'The free trial could not be given automatically, so nothing was given or booked, and the team has been asked to sort it out.',
  retry_again: 'The free trial still could not be added, so nothing was given or booked.',
  not_sent: 'The free trial could not be asked for just now, so nothing was given or booked.',
})

const TRIAL_RETRY = Object.freeze({
  link_sent: false,
  booked: false,
  try_again: true,
  message: `The free trial could not be added just now, so nothing was given or booked. Ask them to try again in a few minutes, or offer to hand off to the team. ${NEVER_TRIAL_YET}`,
})

/** The studio's paid offers for a trial answer; [] when they cannot be read (logged by listPurchaseOptions). */
async function offersOrNone(db, studio) {
  try {
    return (await listPurchaseOptions(db, studio.locationId)).offers
  } catch {
    return []
  }
}

async function trialUsedAnswer(db, studio, settings) {
  const offers = await offersOrNone(db, studio)
  return {
    link_sent: false,
    trial_used: true,
    text: renderMiaCopy('trial_used_text', settings),
    offers,
    message: offers.length
      ? 'They cannot have the free trial, so nothing was given. Send the text, then show the offers as list_purchase_options would: each title and price_label exactly as given, tap choices for 3 or fewer. Never mention the free trial again.'
      : 'They cannot have the free trial, so nothing was given. Send the text, then hand off to the team: nothing else is set up to buy from chat. Never invent an offer or a price.',
  }
}

async function trialNotOfferedAnswer(db, studio) {
  const offers = await offersOrNone(db, studio)
  return {
    link_sent: false,
    trial_available: false,
    offers,
    message: offers.length
      ? 'There is no free trial to give them from chat, so nothing was given. Never mention a free trial. Offer the offers listed here instead, each title and price_label exactly as given.'
      : 'There is no free trial to give them from chat, so nothing was given. Never mention a free trial. Hand off to the team.',
  }
}

/**
 * The originRef of a trial with no class named: `mia-trial:<conversation>`,
 * never null; with no conversation `mia-trial-noconv:<contact>`, a prefix no
 * other filer uses. Pure.
 */
export function trialOriginRef({ conversationId = null, contactId = null, un1tUserId = null } = {}) {
  if (conversationId) return `mia-trial:${conversationId}`
  return `mia-trial-noconv:${contactId || un1tUserId || 'unknown'}`
}

/** What D's grantTrial said, as the row records it (codes only). */
const trialRecord = (g) => ({
  outcome: g?.outcome ?? null,
  method: g?.method ?? null,
  reason: g?.reason ?? null,
  code: g?.code ?? null,
  ledger_id: g?.ledgerId ?? null,
})

/** The un1t_trial_check_failed card: the class keys when a class is named. */
function fileTrialCheckCard(ctx, studio, booking) {
  const who = trialWhoOf(ctx, studio)
  if (booking) {
    return fileUn1tBookingCard(ctx, studio, {
      contactId: booking.executingContactId, match: { event_id: booking.eventId },
      details: booking.details({ reason: 'un1t_trial_check_failed' }),
      summary: [booking.className, booking.classTime, 'free trial check failed, Mia handed over'].filter(Boolean).join(' · '),
    })
  }
  return fileUn1tBookingCard(ctx, studio, {
    contactId: who.contactId, match: { reason: 'un1t_trial_check_failed' },
    details: {
      provider: PROVIDER, origin: 'mia', reason: 'un1t_trial_check_failed',
      un1t_user_id: studio.un1tUserId, executing_contact_id: who.contactId,
    },
    summary: 'free trial check failed, Mia handed over',
  })
}

/**
 * send_purchase_link({ offer_id: 'trial' }): the free trial through D's
 * grantTrial (see the header). Nothing is checked out and no purchase intent
 * is made.
 */
async function sendTrial(ctx, input, studio, { now }) {
  const db = ctx.db
  const settings = await actionSettings(ctx, studio)
  const turn = trialTurnOf(ctx)
  if (turn.granted) return { ...TRIAL_ALREADY_GRANTED }
  if (turn.ineligible) return trialUsedAnswer(db, studio, settings)

  // The class, when one is named: Task 16's pre-flight, nothing written.
  let booking = null
  if (input?.event_id) {
    const prepared = await prepareUn1tBooking(ctx, input, studio, settings, now())
    if (prepared.answer) return prepared.answer
    booking = prepared.booking
  }

  // A's eligibility, before anything is given.
  const trial = await trialAvailable(db, trialWhoOf(ctx, studio))
  if (trial.readFailed) {
    await fileTrialCheckCard(ctx, studio, booking)
    return trialHandoff('un1t_trial_check_failed', settings, TRIAL_LEAD.check_failed)
  }
  if (!trial.available) {
    // A reason from A (trial_used, membership_history, paid_pack) is "had it
    // before"; anything else (no product, or no clear answer) is no trial.
    return trial.reasons.length ? trialUsedAnswer(db, studio, settings) : trialNotOfferedAnswer(db, studio)
  }

  // With a class: Task 16's write-ahead row first; its id is the originRef.
  const contactId = booking?.executingContactId ?? executingContactOf(ctx, studio)
  let requestId = null
  if (booking) {
    requestId = await insertUn1tBookingRow(ctx, studio, { contactId, details: booking.details({ stage: 'trial' }) })
    if (!requestId) return { ...TRIAL_RETRY }
  }
  const originRef = requestId ?? trialOriginRef({ conversationId: ctx.conversationId || null, contactId, un1tUserId: studio.un1tUserId })
  const close = (status, extra) => (requestId
    ? finishUn1tBookingRow(ctx, studio, requestId, { status, details: booking.details(extra) })
    : null)

  let granted
  try {
    granted = await grantTrial(db, {
      locationId: studio.locationId,
      un1tUserId: String(studio.un1tUserId),
      contactId,
      origin: 'mia',
      originRef,
      actor: null,
    })
  } catch (err) {
    // D rejects only before anything was sent (settings, the customer site, a ledger read).
    logError(LOG_MODULE, 'free trial was not asked for', { locationId: studio.locationId, op: 'trial', requestId, status: null, code: err?.code ?? null, errClass: err?.name })
    await close('failed', { reason: 'un1t_trial_not_sent' })
    return trialHandoff('un1t_trial_not_sent', settings, TRIAL_LEAD.not_sent)
  }
  const record = trialRecord(granted)

  if (granted?.outcome === 'granted') {
    turn.granted = true
    if (!booking) {
      return {
        link_sent: false,
        trial_granted: true,
        message: 'The free trial is on their account now. Tell them so, and offer to book a class: list_upcoming_classes, then book_class. Never say a class is booked until book_class says so.',
      }
    }
    // The trial carries onto every later write of this row.
    const withTrial = { ...booking, details: (extra = {}) => booking.details({ trial: record, ...extra }) }
    if (booking.mode === 'draft') {
      // The studio confirms bookings by hand: this row becomes the one draft card.
      await finishUn1tBookingRow(ctx, studio, requestId, { status: 'pending', details: withTrial.details() })
      await alertUn1tBookingCard(ctx, studio, { requestId, summary: [booking.className, booking.classTime, 'free trial given, booking to confirm'].filter(Boolean).join(' · ') })
      return {
        link_sent: false,
        trial_granted: true,
        booked: false,
        pending_approval: true,
        message: 'The free trial is on their account now, and the class is queued for the team to confirm. Tell them both, and that they will hear back shortly. Never say the class is booked yet.',
      }
    }
    // Task 16's outcome handling, except that no_credits is a staff card
    // (afterTrial), never an upsell. Whatever the booking said, the model hears
    // the trial is on their account and that any retry is book_class.
    const answer = await executeUn1tBook(ctx, studio, withTrial, requestId, { settings, afterTrial: true })
    return {
      ...answer,
      trial_granted: true,
      message: answer.message ? `${TRIAL_ON_ACCOUNT} ${answer.message}` : TRIAL_ON_ACCOUNT,
    }
  }

  if (granted?.outcome === 'ineligible') {
    turn.ineligible = true
    await close('failed', { reason: 'un1t_trial_used', trial: record })
    return trialUsedAnswer(db, studio, settings)
  }

  if (granted?.outcome === 'retry') {
    turn.retries += 1
    await close('failed', { reason: 'un1t_trial_retry', trial: record })
    logWarn(LOG_MODULE, 'free trial not given yet; retry', { locationId: studio.locationId, op: 'trial', status: null, code: granted.code ?? null, retries: turn.retries })
    if (turn.retries >= 2) return trialHandoff('un1t_trial_retry', settings, TRIAL_LEAD.retry_again)
    return { ...TRIAL_RETRY }
  }

  // needs_staff (and anything D did not document): exactly ONE card with D's reason.
  const reason = granted?.outcome === 'needs_staff' && typeof granted.reason === 'string' && granted.reason
    ? granted.reason
    : 'un1t_trial_failed:unknown'
  const summary = 'free trial not given, Mia handed over'
  if (booking) {
    await close('pending', { reason, trial: record })
    await alertUn1tBookingCard(ctx, studio, { requestId, summary: [booking.className, booking.classTime, summary].filter(Boolean).join(' · ') })
  } else {
    await fileUn1tBookingCard(ctx, studio, {
      contactId, match: { reason },
      details: {
        provider: PROVIDER, origin: 'mia', reason, un1t_user_id: studio.un1tUserId, executing_contact_id: contactId, trial: record,
      },
      summary,
    })
  }
  logWarn(LOG_MODULE, 'free trial needs the team', { locationId: studio.locationId, op: 'trial', status: null, code: reason })
  return trialHandoff(reason, settings, TRIAL_LEAD.needs_staff)
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
  // The free trial goes through D's grantTrial, never a checkout or an intent.
  if (offerId === TRIAL_OFFER_ID) return sendTrial(ctx, input, studio, { now })
  if (!UUID.test(offerId)) return { ...OFFER_NOT_AVAILABLE }

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
      // Past its 23h. Settle first (Task 19 carry 2): a payment made inside
      // the window is booked, never expired under a second link.
      const settled = await settlePurchaseIntent(db, live.intent.id, { detectedBy: 'tool', source: 'live', now: () => nowMs })
      const title = String(live.intent.product_title || '').trim() || 'their purchase'
      if (PAID_OUTCOMES.has(settled.outcome)) return { ...paidAnswer(settled, title, live.intent.id), link_sent: false }
      if (settled.outcome === 'already_settled') return { ...ALREADY_SETTLED, link_sent: false }
      if (settled.outcome === 'expired' && settled.payment_seen) return { ...PAYMENT_PENDING }
      if (settled.outcome !== 'expired' && settled.outcome !== 'refused') return { ...TRY_AGAIN }
      // Not paid: expire it quietly (the post-sync sweep would), which frees
      // the member (a refused one is no longer live already).
      if (settled.outcome === 'expired') await writeLiveIntent(db, studio, live.intent.id, { status: 'expired' }, 'purchase_expire', nowMs)
      const again = await readLiveIntent(db, studio)
      if (again.error) return { ...TRY_AGAIN }
      if (again.intent) return answerLiveIntent(ctx, studio, again.intent, product, settings, nowMs, undefined, input)
    } else {
      return answerLiveIntent(ctx, studio, live.intent, product, settings, nowMs, undefined, input)
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
    return answerLiveIntent(ctx, studio, raced.intent, product, settings, nowMs, base, input)
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
  if (out.free) {
    await storeFreeLedger(db, studio, intentId, out, nowMs)
    return settleFree(db, intentId, title, nowMs)
  }

  const stored = await writeLiveIntent(db, studio, intentId, { checkout_url: out.url, ...ledgerPatch(out) }, 'purchase_store_link', nowMs)
  // Still sent: the member can pay, and detection reads the entitlement, not the URL.
  if (!stored) logError(LOG_MODULE, 'payment link not stored on the intent', { locationId: studio.locationId, op: 'purchase_store_link', intentId, status: null })
  return linkAnswer(out.url, { product: title, priceLabel: priceLabelOf(product), className: klass.class_name, classTime: klass.class_time, intentId }, settings)
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
  // MIAHATCH.6 (Task 20) — the free trial first, only when A says eligible.
  // Only a verified member with an account is asked about (else no trial).
  const trial = ctx.verifiedContactId && studio.un1tUserId
    ? await trialAvailable(ctx.db, trialWhoOf(ctx, studio))
    : { available: false, reasons: [] }
  const settings = await actionSettings(ctx, studio)
  if (trial.readFailed) {
    await fileTrialCheckCard(ctx, studio, null)
    return trialHandoff('un1t_trial_check_failed', settings, TRIAL_LEAD.check_failed)
  }
  if (!listed.offers.length && !trial.available) {
    return {
      offers: [],
      trial_available: false,
      message: 'Nothing is set up to buy from chat at this studio. Never invent an offer or a price: hand off to the team.',
    }
  }
  const listLine = 'Give each title and price_label exactly as listed. With 3 or fewer offers, offer them as tap choices; with more, list them. Never offer anything that is not listed.'
  const message = trial.available
    ? `${TRIAL_FIRST_MESSAGE} Then introduce the paid offers with the wording. ${listLine}`
    : `Introduce them with the wording. ${listLine}`
  // MIAFIX.1 (3) — the member's open link, so Mia never offers a second one.
  const openLink = ctx.verifiedContactId && studio.un1tUserId ? await openLinkOf(ctx.db, studio, Date.now()) : null
  return {
    offers: listed.offers,
    trial_available: trial.available,
    wording: renderMiaCopy('purchase_offer_intro_text', settings, { studio: studio.name }),
    ...(openLink ? { open_link: openLink } : {}),
    message: openLink ? `${openLinkMessage(openLink.product)} ${message}` : message,
  }
}

/**
 * MIAFIX.1 (3) — the member's live payment link at the studio, for
 * list_purchase_options: { product, link_waiting: true }, or null with none,
 * one past its expiry (send_purchase_link settles and replaces it), or a read
 * that failed (logged by readMemberLiveIntent; send_purchase_link reads it
 * again and still refuses a second link). Never the URL.
 */
async function openLinkOf(db, studio, nowMs) {
  const live = await readLiveIntent(db, studio)
  if (live.error || !live.intent) return null
  const expiresMs = Date.parse(live.intent.expires_at || '')
  if (Number.isFinite(expiresMs) && expiresMs <= nowMs) return null
  return { product: String(live.intent.product_title || '').trim() || 'their purchase', link_waiting: true }
}

// Review fix (MIAFIX.1) — a customer asking for a DIFFERENT product is sent to
// send_purchase_link in this same turn (its open_link_handoff is the
// deterministic handoff); only a "what can I buy" mentions the waiting link.
const openLinkMessage = (product) =>
  `They already have a payment link waiting for ${product}. If the customer is asking for a different product than ${product}, call send_purchase_link with that product's offer_id now, in this turn, with no restating and no yes needed: no new link is made and it hands them to the team. Only when they are just asking what is available, mention their ${product} link is waiting and never offer to send a link for a different product. Never call send_purchase_link for a product they did not ask for.`
