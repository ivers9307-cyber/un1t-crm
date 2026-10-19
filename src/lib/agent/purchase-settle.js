// MIAHATCH.6 (Task 21) — settling a paid purchase intent exactly once and
// booking its class; check_my_purchase; the silent expiry sweep (spec 6.5
// step 5, 6.5.1, 6.5.2; Review Focus 3). purchase-intents.js (the offers, the
// links, the trial) imports this module; this one never imports it.
//
// Three detectors (the /pay-done page, check_my_purchase, the 5-minute
// watcher cron, mirror only) call settlePurchaseIntent, which is safe to call
// concurrently: the one whose CAS link_sent -> paid returns the row is the
// winner and does everything (the double-payment card, the class booking
// through Task 16's execute step, ONE in-thread message, the final status); a
// loser gets already_settled and does nothing. "Paid" is the entitlement
// against the snapshot taken when the link was made (paidSinceSnapshot), read
// live or from the mirror (zero un1t.online calls), or a purchase the mirror dates inside
// the intent's window; the un1t_transactions row records which product was
// bought (a different product still counts: un1t.online arbitrates). An
// expired intent settles nothing and says nothing (Review Focus 3), unless the
// mirror dates a purchase INSIDE its window: a member who paid at 22h50 and is
// only seen at 23h05 is still booked. Refunds are never automatic (R2): a
// double payment is a record-only refund_request card, and no amount reaches
// the member's thread.
//
// Every intent write is status-guarded and stamps updated_at; every read and
// write judges `error`. Logs: module 'mia-un1t', codes and ids only (never a
// checkout URL, token, amount, name, phone or email).
import { fileRefundCard } from '@/lib/un1t-online-approval'
import { MEMBERSHIP_ACTIVE_STATUSES } from '@/lib/un1t-online-map'
import { DEFAULT_TZ, getLocationZone } from '@/lib/location-time'
import { logError, logWarn } from '@/lib/log'
import { sendAgentThreadMessage } from './notify'
import { resolveAgentSettings } from './settings-resolve'
import { renderMiaCopy } from './mia-copy'
import { fetchLiveEntitlement } from './un1t-member-read'
import { executeUn1tBook, fileUn1tBookingCard, insertUn1tBookingRow, prepareUn1tBooking } from './un1t-booking'

const LOG_MODULE = 'mia-un1t'
const PROVIDER = 'un1t_online'
const INTENTS = 'mia_purchase_intents'
const LIVE = 'link_sent'

const classLine = (name, time) => [name, time].map((v) => String(v || '').trim()).filter(Boolean).join(', ')
const NOT_VERIFIED = Object.freeze({ error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' })
const NOT_LINKED_MESSAGE = 'No account was found for this person at this studio, so there is no payment to check. Offer to hand off to the team.'

/**
 * The member's live intent at the studio (the one link_sent row the partial
 * unique index allows): { intent } (null when none) or { error: true }.
 * @param {string} cols the columns to read
 */
export async function readMemberLiveIntent(db, studio, cols) {
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

const SETTLE_COLS = 'id, location_id, contact_id, conversation_id, channel, un1t_user_id, un1t_product_id, product_title, event_un1t_id, class_name, class_time, starts_at, status, entitlement_snapshot, outcome, created_at, expires_at, paid_detected_at'
const TX_COLS = 'un1t_id, product_id, product_title, type, amount_cents, remote_created_at'
/** Purchases read per settle: far above what one member makes in a 23h window. */
const TX_PAGE = 100
/** Rows per page of the expiry sweep (under the 1,000-row select cap). */
export const EXPIRE_PAGE = 500
/**
 * How long past expires_at the sweep leaves a live intent alone: longer than
 * one 15-minute un1t mirror sync plus one 5-minute watcher tick, with margin,
 * so a payment made just before expiry is still dated by the mirror and
 * settled by the watcher before the sweep can close the intent.
 */
export const EXPIRY_GRACE_MS = 45 * 60_000

/** The outcomes where the member paid and has been (or should have been) told. */
export const PAID_OUTCOMES = new Set(['paid_booked', 'paid_class_gone', 'paid_booking_failed', 'paid_no_class'])
const COPY_KEY = Object.freeze({
  paid_booked: 'purchase_paid_booked_text',
  paid_class_gone: 'purchase_paid_class_gone_text',
  paid_booking_failed: 'purchase_paid_booking_failed_text',
  paid_no_class: 'purchase_paid_no_class_text',
})
const FINAL_STATUS = Object.freeze({
  paid_booked: 'booked',
  paid_class_gone: 'book_failed',
  paid_booking_failed: 'book_failed',
  paid_no_class: 'no_class',
})

const idList = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && x !== '').map(String) : [])
const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Did the member pay since the link was made? Entitled now against the
 * snapshot taken then: the balance went up, unlimited turned on, or a live
 * subscription id appeared that was not there. A snapshot that could not be
 * read then (ok !== true), or no answer now, is never "paid" here. Pure.
 *
 * @param {{ ok?: boolean, balance?: number|null, unlimited?: boolean, live_subscription_ids?: string[] }|null} snapshot
 *   the intent's entitlement_snapshot
 * @param {{ balance?: number|null, unlimited?: boolean, liveSubscriptionIds?: string[] }|null} now
 * @returns {boolean}
 */
export function paidSinceSnapshot(snapshot, now) {
  if (!snapshot || snapshot.ok !== true || !now) return false
  if (now.unlimited === true && snapshot.unlimited !== true) return true
  const before = finiteOrNull(snapshot.balance)
  const after = finiteOrNull(now.balance)
  if (before !== null && after !== null && after > before) return true
  const had = new Set(idList(snapshot.live_subscription_ids ?? snapshot.liveSubscriptionIds))
  return idList(now.liveSubscriptionIds ?? now.live_subscription_ids).some((id) => !had.has(id))
}

/** One intent row by id: { intent } (null when none) or { error: true }. */
async function readIntent(db, intentId) {
  try {
    const { data, error } = await db.from(INTENTS).select(SETTLE_COLS).eq('id', intentId).maybeSingle()
    if (error) {
      logWarn(LOG_MODULE, 'intent unreadable', { op: 'settle_read', intentId, status: null, code: error.code ?? null })
      return { error: true }
    }
    return { intent: data ?? null }
  } catch (err) {
    logWarn(LOG_MODULE, 'intent read threw', { op: 'settle_read', intentId, status: null, errClass: err?.name })
    return { error: true }
  }
}

/**
 * The member's purchases in the mirror since the intent was made (zero
 * un1t.online calls): rows with an amount above zero, renewals of a
 * membership they already held left out. [] when unreadable (logged): the
 * product match and the double-payment check are then simply not made.
 */
async function purchasesSince(db, intent) {
  try {
    const { data, error } = await db.from('un1t_transactions')
      .select(TX_COLS)
      .eq('location_id', intent.location_id)
      .eq('un1t_user_id', String(intent.un1t_user_id))
      .gte('remote_created_at', intent.created_at)
      .order('remote_created_at', { ascending: true })
      .order('un1t_id', { ascending: true })
      .range(0, TX_PAGE - 1)
    if (error) {
      logWarn(LOG_MODULE, 'purchases unreadable', { locationId: intent.location_id, op: 'settle_purchases', intentId: intent.id, status: null, code: error.code ?? null })
      return []
    }
    return (Array.isArray(data) ? data : []).filter((t) => Number(t?.amount_cents) > 0 && t?.type !== 'sub_renewal' && t?.un1t_id)
  } catch (err) {
    logWarn(LOG_MODULE, 'purchases read threw', { locationId: intent.location_id, op: 'settle_purchases', intentId: intent.id, status: null, errClass: err?.name })
    return []
  }
}

/**
 * The member's entitlement from the mirror (zero un1t.online calls): the
 * client row's credits only when the sync wrote it AFTER the link was made
 * (an older row says nothing about a payment since), and the live
 * subscriptions. null when unreadable.
 */
async function mirrorEntitlement(db, intent) {
  try {
    const { data: client, error } = await db.from('un1t_clients')
      .select('credit_balance, credit_unlimited, synced_at')
      .eq('location_id', intent.location_id)
      .eq('un1t_user_id', String(intent.un1t_user_id))
      .maybeSingle()
    if (error) {
      logWarn(LOG_MODULE, 'mirror read failed', { locationId: intent.location_id, op: 'settle_client', intentId: intent.id, status: null, code: error.code ?? null })
      return null
    }
    const { data: subs, error: subsError } = await db.from('un1t_subscriptions')
      .select('un1t_id')
      .eq('location_id', intent.location_id)
      .eq('un1t_user_id', String(intent.un1t_user_id))
      .in('status', [...MEMBERSHIP_ACTIVE_STATUSES])
      .order('un1t_id')
    if (subsError) {
      logWarn(LOG_MODULE, 'mirror read failed', { locationId: intent.location_id, op: 'settle_subscriptions', intentId: intent.id, status: null, code: subsError.code ?? null })
      return null
    }
    const fresh = client && Date.parse(client.synced_at) >= Date.parse(intent.created_at)
    return {
      balance: fresh ? finiteOrNull(client.credit_balance) : null,
      unlimited: fresh ? client.credit_unlimited === true : false,
      liveSubscriptionIds: idList((Array.isArray(subs) ? subs : []).map((r) => r?.un1t_id)),
    }
  } catch (err) {
    logWarn(LOG_MODULE, 'mirror read threw', { locationId: intent.location_id, op: 'settle_mirror', intentId: intent.id, status: null, errClass: err?.name })
    return null
  }
}

/** The entitlement now: live (one budgeted read; a failed one falls back to the mirror) or the mirror alone. */
async function entitlementNow(db, intent, source) {
  if (source === 'live') {
    try {
      const ent = await fetchLiveEntitlement(db, { locationId: intent.location_id, un1tUserId: intent.un1t_user_id })
      if (ent?.ok) return { balance: ent.balance ?? null, unlimited: ent.unlimited === true, liveSubscriptionIds: ent.liveSubscriptionIds || [] }
    } catch (err) {
      logWarn(LOG_MODULE, 'live entitlement threw; the mirror instead', { locationId: intent.location_id, op: 'settle_live', intentId: intent.id, status: null, errClass: err?.name })
    }
  }
  return mirrorEntitlement(db, intent)
}

/** Which product the member actually bought, as the outcome records it (the intent's own first). */
function productBought(purchases, intent) {
  const want = String(intent.un1t_product_id)
  const t = purchases.find((p) => String(p.product_id) === want) ?? purchases[0]
  if (!t) return null
  return { transaction_id: String(t.un1t_id), product_id: t.product_id ?? null, product_title: t.product_title ?? null, matches_intent: String(t.product_id) === want }
}

/** How long after the payment was detected a second purchase still counts as paying twice for this intent. */
export const DOUBLE_PAYMENT_GRACE_MS = 60 * 60_000

/**
 * The end of the double-payment window: min(expires_at, paid + 60 min), with
 * paid the settle's CAS instant (the winner) or paid_detected_at (the
 * re-check). A later purchase of the same product is a new purchase (bought
 * again for another class), never a double payment. NaN when neither is known.
 */
function doublePaymentUntil(intent, paidAtMs) {
  const ends = [Date.parse(intent.expires_at || ''), paidAtMs + DOUBLE_PAYMENT_GRACE_MS].filter(Number.isFinite)
  return ends.length ? Math.min(...ends) : NaN
}

/**
 * Two or more purchases of the intent's product inside its double-payment
 * window ([created_at, doublePaymentUntil]): ONE record-only refund_request
 * card (D's fileRefundCard, deduped on the intent id). Nothing is refunded and
 * nothing reaches the member (R2). The winner and the watcher's re-check both
 * judge through here, so they agree.
 */
async function fileDoublePayment(db, intent, purchases, paidAtMs) {
  const until = doublePaymentUntil(intent, paidAtMs)
  const same = purchases.filter((p) => String(p.product_id) === String(intent.un1t_product_id)
    && Date.parse(p.remote_created_at) <= until)
  if (same.length < 2) return null
  const transactionIds = same.map((p) => String(p.un1t_id))
  let approvalId = null
  try {
    ;({ approvalId = null } = await fileRefundCard(db, {
      locationId: intent.location_id,
      contactId: intent.contact_id ?? null,
      un1tUserId: String(intent.un1t_user_id),
      reason: 'double_payment',
      transactionIds,
      origin: 'mia',
      originRef: intent.id,
      channel: 'whatsapp',
      conversationId: intent.conversation_id ?? null,
    }) || {})
  } catch (err) {
    logError(LOG_MODULE, 'double payment card threw', { locationId: intent.location_id, op: 'double_payment', intentId: intent.id, status: null, errClass: err?.name })
  }
  const log = approvalId ? logWarn : logError
  log(LOG_MODULE, approvalId ? 'double payment; refund_request card filed' : 'double payment; refund_request card NOT filed', {
    locationId: intent.location_id, op: 'double_payment', intentId: intent.id, approvalId, count: transactionIds.length, status: null,
  })
  return { transaction_ids: transactionIds, approval_id: approvalId }
}

/** The studio's resolved Mia settings (copy, booking_mode), or null: the copy defaults, and draft for booking. */
async function settingsFor(db, locationId) {
  try {
    const r = await resolveAgentSettings(db, locationId)
    if (r?.ok) return r.settings
    logWarn(LOG_MODULE, 'studio Mia settings unreadable; copy defaults, draft booking', { locationId, op: 'settle_settings', status: null, code: r?.reason ?? null })
    return null
  } catch (err) {
    logWarn(LOG_MODULE, 'studio Mia settings threw; copy defaults, draft booking', { locationId, op: 'settle_settings', status: null, code: 'threw', errClass: err?.name ?? null })
    return null
  }
}

/** The class's start from the mirror, for an intent that holds only its id. */
async function eventStartsAt(db, intent) {
  const { data, error } = await db.from('un1t_events')
    .select('starts_at')
    .eq('location_id', intent.location_id)
    .eq('un1t_id', intent.event_un1t_id)
    .maybeSingle()
  return error ? null : (data?.starts_at ?? null)
}

/**
 * The tool context and studio settle runs Task 16's booking steps with: it has
 * no turn, so both are built from the intent (its contact is the executing
 * contact; the studio's own zone, the default when unreadable).
 */
async function contextFor(db, intent, settings) {
  let zone = DEFAULT_TZ
  try {
    zone = await getLocationZone(db, intent.location_id)
  } catch (err) {
    logWarn(LOG_MODULE, 'studio zone unreadable; the default zone', { locationId: intent.location_id, op: 'settle_zone', status: null, errClass: err?.name })
  }
  const studio = {
    locationId: intent.location_id, un1tUserId: String(intent.un1t_user_id), providerKey: PROVIDER, name: null,
    contactIds: intent.contact_id ? [intent.contact_id] : [],
  }
  const ctx = {
    db, locationId: intent.location_id, zone, verifiedContactId: intent.contact_id ?? null, contactId: intent.contact_id ?? null,
    channel: intent.channel || 'whatsapp', conversationId: intent.conversation_id ?? null, settings, nameHint: null,
    actionStudio: async () => settings,
  }
  return { ctx, studio }
}

/**
 * The paid intent's class: re-checked (Task 16's pre-flight: scheduled, not
 * started, in the latest pull), then Task 16's execute step on a write-ahead
 * class_booking row (its id the originRef). Settle has no turn, so the tool
 * context is built from the intent.
 *
 * @returns {Promise<{ outcome: string, className: string|null, classTime: string|null, record: object, requestId?: string|null }>}
 */
async function bookPaidClass(db, intent, settings, nowMs) {
  const className = intent.class_name ?? null
  const classTime = intent.class_time ?? null
  if (!intent.event_un1t_id) return { outcome: 'paid_no_class', className, classTime, record: {} }

  const { ctx, studio } = await contextFor(db, intent, settings)
  const startsAt = intent.starts_at ?? await eventStartsAt(db, intent)
  const prepared = await prepareUn1tBooking(ctx, { event_id: `un1t:${intent.event_un1t_id}`, class_name: className, starts_at: startsAt }, studio, settings, nowMs)
  if (prepared.answer) {
    if (prepared.answer.error === 'class_unavailable') {
      return { outcome: 'paid_class_gone', className, classTime, record: { reason: prepared.answer.reason ?? 'class_unavailable' } }
    }
    // The class could not be read just now: the team books it.
    const requestId = await fileUn1tBookingCard(ctx, studio, {
      contactId: intent.contact_id, match: { purchase_intent_id: intent.id },
      details: {
        provider: PROVIDER, origin: 'mia', reason: 'paid_booking_failed', paid_outcome: 'class_unreadable',
        event_id: intent.event_un1t_id, un1t_user_id: String(intent.un1t_user_id), executing_contact_id: intent.contact_id ?? null,
        starts_at: startsAt, class_name: className, class_time: classTime, purchase_intent_id: intent.id,
      },
      summary: [className, classTime, 'paid, booking not made, Mia handed over'].filter(Boolean).join(' · '),
    })
    return { outcome: 'paid_booking_failed', className, classTime, requestId, record: { reason: 'class_unreadable', request_id: requestId } }
  }

  const base = prepared.booking
  const booking = { ...base, details: (extra = {}) => base.details({ purchase_intent_id: intent.id, ...extra }) }
  const named = { className: booking.className, classTime: booking.classTime }

  if (booking.mode === 'draft') {
    // The studio confirms bookings by hand: one draft card, the member told the team will confirm.
    const requestId = await fileUn1tBookingCard(ctx, studio, {
      contactId: booking.executingContactId, match: { event_id: booking.eventId }, details: booking.details({ stage: 'paid' }),
      summary: [booking.className, booking.classTime, 'paid, booking to confirm'].filter(Boolean).join(' · '),
    })
    return { outcome: 'paid_booking_failed', ...named, requestId, record: { reason: 'draft', request_id: requestId } }
  }

  const requestId = await insertUn1tBookingRow(ctx, studio, { contactId: booking.executingContactId, details: booking.details({ stage: 'executing' }) })
  if (!requestId) {
    const cardId = await fileUn1tBookingCard(ctx, studio, {
      contactId: booking.executingContactId, match: { purchase_intent_id: intent.id },
      details: booking.details({ reason: 'paid_booking_failed', paid_outcome: 'row_not_written' }),
      summary: [booking.className, booking.classTime, 'paid, booking not made, Mia handed over'].filter(Boolean).join(' · '),
    })
    return { outcome: 'paid_booking_failed', ...named, requestId: cardId, record: { reason: 'row_not_written', request_id: cardId } }
  }
  const answer = await executeUn1tBook(ctx, studio, booking, requestId, { settings, afterPurchase: true })
  if (answer?.booked === true) return { outcome: 'paid_booked', ...named, record: { request_id: requestId } }
  if (answer?.reason === 'class_full') return { outcome: 'paid_class_gone', ...named, record: { reason: 'class_full', request_id: requestId } }
  return { outcome: 'paid_booking_failed', ...named, requestId, record: { reason: answer?.paid_outcome ?? 'booking_failed', request_id: requestId } }
}

/** ONE in-thread message; its answer, never a throw (a failed send never changes the booking). */
async function sendPaidMessage(db, intent, text) {
  if (!intent.conversation_id) return { sent: false, reason: 'no_conversation' }
  try {
    const res = await sendAgentThreadMessage(db, { channel: intent.channel || 'whatsapp', conversationId: intent.conversation_id, text })
    return res?.sent === true ? { sent: true } : { sent: false, reason: res?.reason || 'not_sent' }
  } catch (err) {
    logWarn(LOG_MODULE, 'paid confirmation send threw', { locationId: intent.location_id, op: 'settle_send', intentId: intent.id, status: null, errClass: err?.name })
    return { sent: false, reason: 'send_error' }
  }
}

/** A confirmation that did not go out is recorded on the card too (still pending only; never a retry). */
async function noteConfirmationOnCard(db, intent, requestId, confirmation) {
  try {
    const { data: card, error } = await db.from('agent_membership_requests')
      .select('id, details')
      .eq('id', requestId)
      .eq('location_id', intent.location_id)
      .maybeSingle()
    if (error || !card) {
      logWarn(LOG_MODULE, 'card unreadable; confirmation not noted on it', { locationId: intent.location_id, op: 'settle_card_note', intentId: intent.id, requestId, status: null, code: error?.code ?? null })
      return
    }
    const { data, error: writeError } = await db.from('agent_membership_requests')
      .update({ details: { ...(card.details || {}), confirmation }, updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('status', 'pending')
      .select('id')
    if (writeError || !Array.isArray(data) || data.length === 0) {
      logWarn(LOG_MODULE, 'confirmation not noted on the card', { locationId: intent.location_id, op: 'settle_card_note', intentId: intent.id, requestId, status: null, code: writeError?.code ?? null })
    }
  } catch (err) {
    logWarn(LOG_MODULE, 'card note threw', { locationId: intent.location_id, op: 'settle_card_note', intentId: intent.id, requestId, status: null, errClass: err?.name })
  }
}

/**
 * Settle one purchase intent: safe to call from every detector at once
 * (see the header). The winner's steps: the double-payment card, the class
 * booked through Task 16's execute step, ONE purchase_paid_* message
 * (sendAgentThreadMessage; a closed window is recorded, never retried), the
 * final status booked / book_failed / no_class with everything in `outcome`.
 * Paid = a purchase the mirror dates inside the window (any product), or the
 * entitlement up since the snapshot (a live intent only). A throw after the
 * CAS closes the intent book_failed with one paid_booking_failed card
 * (settleThrew) and is never rethrown; a process killed mid-settle leaves it
 * 'paid' for the watcher's markStuckPaidIntent.
 *
 * @param {object} db service-role client
 * @param {string} intentId
 * @param {{ detectedBy: 'pay_done'|'tool'|'watcher', source?: 'live'|'mirror', free?: boolean, now?: () => number }} opts
 *   source 'mirror': zero un1t.online calls. free: un1t.online answered the
 *   checkout as free, so it is paid now (no entitlement check).
 * @returns {Promise<{ outcome: 'not_paid'|'paid_booked'|'paid_class_gone'|'paid_booking_failed'|'paid_no_class'
 *   |'already_settled'|'expired'|'refused'|'not_found'|'error', sent: boolean, text?: string, payment_seen?: boolean, error?: string }>}
 *   `text` is what the member was (or, with sent false, should be) told;
 *   `payment_seen` (expired only) is a payment the entitlement shows that the
 *   mirror cannot yet date inside the window.
 */
export async function settlePurchaseIntent(db, intentId, { detectedBy, source = 'live', free = false, now = () => Date.now() } = {}) {
  const nowMs = now()
  const read = await readIntent(db, intentId)
  if (read.error) return { outcome: 'error', sent: false }
  const intent = read.intent
  if (!intent) return { outcome: 'not_found', sent: false }
  if (intent.status === 'expired') return { outcome: 'expired', sent: false }
  // A link that was never made (checkout refused): nothing to pay, never "paid".
  if (intent.status === 'refused') return { outcome: 'refused', sent: false }
  if (intent.status !== LIVE) return { outcome: 'already_settled', sent: false }

  const purchases = await purchasesSince(db, intent)
  const expiresMs = Date.parse(intent.expires_at || '')
  const lapsed = !(expiresMs > nowMs)
  // Any purchase of the member's the mirror dates inside the window (any
  // product) proves payment, live or lapsed alike.
  const inWindow = purchases.some((p) => Date.parse(p.remote_created_at) <= expiresMs)
  let paid
  if (free || inWindow) paid = true
  else if (lapsed) {
    // Review Focus 3: a lapsed intent settles only on a purchase dated inside its window.
    const ent = await entitlementNow(db, intent, source)
    return { outcome: 'expired', sent: false, payment_seen: purchases.length > 0 || paidSinceSnapshot(intent.entitlement_snapshot, ent) }
  } else {
    paid = paidSinceSnapshot(intent.entitlement_snapshot, await entitlementNow(db, intent, source))
  }
  if (!paid) return { outcome: 'not_paid', sent: false }

  // The CAS: exactly one detector gets the row back.
  const stamp = new Date(nowMs).toISOString()
  const outcome = {
    source: free ? 'checkout' : source,
    ...(free ? { free: true } : {}),
    ...(lapsed ? { seen_after_expiry: true } : {}),
    product: productBought(purchases, intent),
  }
  let won
  try {
    const { data, error } = await db.from(INTENTS)
      .update({ status: 'paid', paid_detected_at: stamp, detected_by: detectedBy, outcome, updated_at: stamp })
      .eq('id', intent.id)
      .eq('status', LIVE)
      .select('id')
    if (error) {
      logError(LOG_MODULE, 'settle write failed', { locationId: intent.location_id, op: 'settle_cas', intentId: intent.id, status: null, code: error.code ?? null })
      return { outcome: 'error', sent: false }
    }
    won = Array.isArray(data) && data.length > 0
  } catch (err) {
    logError(LOG_MODULE, 'settle write threw', { locationId: intent.location_id, op: 'settle_cas', intentId: intent.id, status: null, errClass: err?.name })
    return { outcome: 'error', sent: false }
  }
  if (!won) return { outcome: 'already_settled', sent: false }

  // The winner. Nothing after the CAS may leave the intent in 'paid': a throw
  // closes it book_failed with one staff card, and never reaches the caller.
  const progress = { confirmation: null, text: null }
  try {
    return await settleWinner(db, intent, outcome, purchases, nowMs, progress)
  } catch (err) {
    return settleThrew(db, intent, outcome, err, nowMs, progress)
  }
}

/** The winner's steps (see settlePurchaseIntent). `progress` records the send, so a later throw never sends twice. */
async function settleWinner(db, intent, outcome, purchases, nowMs, progress) {
  const doubled = await fileDoublePayment(db, intent, purchases, nowMs)
  const settings = await settingsFor(db, intent.location_id)
  const booked = await bookPaidClass(db, intent, settings, nowMs)
  const text = renderMiaCopy(COPY_KEY[booked.outcome], settings, { class: classLine(booked.className, booked.classTime) || null })
  progress.text = text
  const confirmation = await sendPaidMessage(db, intent, text)
  progress.confirmation = confirmation
  if (!confirmation.sent && booked.requestId) await noteConfirmationOnCard(db, intent, booked.requestId, confirmation)
  if (!confirmation.sent) {
    logWarn(LOG_MODULE, 'paid confirmation not sent', { locationId: intent.location_id, op: 'settle_send', intentId: intent.id, status: null, code: confirmation.reason })
  }

  const final = {
    ...outcome,
    result: booked.outcome,
    booking: booked.record,
    ...(doubled ? { double_payment: doubled } : {}),
    confirmation,
  }
  const { data, error } = await db.from(INTENTS)
    .update({ status: FINAL_STATUS[booked.outcome], outcome: final, updated_at: new Date(nowMs).toISOString() })
    .eq('id', intent.id)
    .eq('status', 'paid')
    .select('id')
  if (error || !Array.isArray(data) || data.length === 0) {
    logError(LOG_MODULE, 'settled intent not finalised (left paid)', { locationId: intent.location_id, op: 'settle_final', intentId: intent.id, status: null, code: error?.code ?? null })
  }
  return { outcome: booked.outcome, sent: confirmation.sent, text }
}

const errCode = (err) => String(err?.code ?? err?.name ?? 'threw')

/**
 * Something after the winning CAS threw. The member has paid: they hear the
 * booking-failed text (unless a message already went), the team gets ONE
 * paid_booking_failed card, and the intent is closed book_failed with the
 * error code. Never rethrows.
 */
async function settleThrew(db, intent, outcome, err, nowMs, progress) {
  const code = errCode(err)
  logError(LOG_MODULE, 'settle threw after the CAS; intent closed book_failed', { locationId: intent.location_id, op: 'settle_threw', intentId: intent.id, status: null, code, errClass: err?.name ?? null })
  let confirmation = progress.confirmation
  let text = progress.text
  if (!confirmation) {
    const settings = await settingsFor(db, intent.location_id)
    const key = intent.event_un1t_id ? 'purchase_paid_booking_failed_text' : 'purchase_paid_no_class_text'
    text = renderMiaCopy(key, settings, { class: classLine(intent.class_name, intent.class_time) || null })
    confirmation = await sendPaidMessage(db, intent, text)
  }
  await closeStuckPaid(db, intent, { baseOutcome: outcome, code, confirmation, nowMs })
  return { outcome: 'paid_booking_failed', sent: confirmation?.sent === true, text, error: code }
}

/** ONE paid_booking_failed card for a paid intent whose booking never finished (best effort, logged); its id or null. */
async function fileStuckCard(db, intent, code) {
  try {
    const { ctx, studio } = await contextFor(db, intent, null)
    const className = intent.class_name ?? null
    const classTime = intent.class_time ?? null
    return await fileUn1tBookingCard(ctx, studio, {
      contactId: intent.contact_id ?? null,
      // The write-ahead row (pending, same purchase_intent_id) is reused when it is still open.
      match: { purchase_intent_id: intent.id },
      details: {
        provider: PROVIDER, origin: 'mia', reason: 'paid_booking_failed', paid_outcome: code,
        event_id: intent.event_un1t_id ?? null, un1t_user_id: String(intent.un1t_user_id), executing_contact_id: intent.contact_id ?? null,
        starts_at: intent.starts_at ?? null, class_name: className, class_time: classTime, purchase_intent_id: intent.id,
        summary: 'The member paid through Mia\'s payment link, but settling it did not finish. Check the member and the class in un1t.online; Approve books the class only if it is not there already.',
      },
      summary: [className, classTime, 'paid, settling did not finish, Mia handed over'].filter(Boolean).join(' · '),
    })
  } catch (err) {
    logError(LOG_MODULE, 'stuck paid intent card not filed', { locationId: intent.location_id, op: 'settle_stuck_card', intentId: intent.id, status: null, errClass: err?.name ?? null })
    return null
  }
}

/** File the card, then close the intent paid -> book_failed (status-guarded, updated_at, the code in outcome). Never throws. */
async function closeStuckPaid(db, intent, { baseOutcome, code, confirmation = null, nowMs }) {
  const requestId = await fileStuckCard(db, intent, code)
  const final = {
    ...(baseOutcome || {}),
    result: 'paid_booking_failed',
    error: { code },
    booking: { reason: 'settle_did_not_finish', request_id: requestId },
    ...(confirmation ? { confirmation } : {}),
  }
  try {
    const { data, error } = await db.from(INTENTS)
      .update({ status: 'book_failed', outcome: final, updated_at: new Date(nowMs).toISOString() })
      .eq('id', intent.id)
      .eq('status', 'paid')
      .select('id')
    if (error || !Array.isArray(data) || data.length === 0) {
      logError(LOG_MODULE, 'stuck paid intent not closed', { locationId: intent.location_id, op: 'settle_stuck_close', intentId: intent.id, status: null, code: error?.code ?? null })
      return { closed: false, requestId }
    }
    return { closed: true, requestId }
  } catch (err) {
    logError(LOG_MODULE, 'stuck paid intent close threw', { locationId: intent.location_id, op: 'settle_stuck_close', intentId: intent.id, status: null, errClass: err?.name ?? null })
    return { closed: false, requestId }
  }
}

/**
 * For the watcher cron (Task 23): an intent left in 'paid' (a process
 * killed mid-settle) is closed book_failed with ONE paid_booking_failed staff
 * card. Nothing is booked again and nothing is sent. A no-op unless the
 * intent is still 'paid'. Never throws.
 *
 * @param {object} db service-role client
 * @param {string} intentId
 * @param {{ code?: string, now?: number }} [opts] code recorded as outcome.error.code
 * @returns {Promise<{ marked: boolean, requestId?: string|null }>}
 */
export async function markStuckPaidIntent(db, intentId, { code = 'stuck_paid', now = Date.now() } = {}) {
  const read = await readIntent(db, intentId)
  if (read.error || !read.intent || read.intent.status !== 'paid') return { marked: false }
  const intent = read.intent
  const { closed, requestId } = await closeStuckPaid(db, intent, { baseOutcome: intent.outcome, code, confirmation: intent.outcome?.confirmation ?? null, nowMs: now })
  return { marked: closed, requestId }
}

/**
 * The final statuses a settle leaves behind, the ones the watcher re-checks.
 * Not 'paid': the live winner judges that itself, and the re-check picks the
 * intent up once it leaves 'paid'.
 */
export const RECHECK_STATUSES = Object.freeze(['booked', 'book_failed', 'no_class'])

/**
 * For the watcher cron (Task 23): the settle winner's double-payment check run
 * again on a settled intent, mirror only (zero un1t.online calls), so a second
 * payment the mirror shows only after the settle still reaches the team as ONE
 * record-only refund_request card (deduped on the intent id while pending).
 * The same window as the winner (paid = paid_detected_at). Once a card is
 * filed it is recorded on the intent's outcome (status-guarded), so a later
 * run asks nothing again. Nothing is refunded and nothing reaches the member.
 * Never throws.
 *
 * @param {object} db service-role client
 * @param {string} intentId
 * @returns {Promise<{ filed: boolean }>} filed: a card was filed (or found pending) this time
 */
export async function recheckDoublePayment(db, intentId, { now = Date.now() } = {}) {
  try {
    const read = await readIntent(db, intentId)
    const intent = read.intent
    if (read.error || !intent || !RECHECK_STATUSES.includes(intent.status)) return { filed: false }
    if (intent.outcome?.double_payment?.approval_id) return { filed: false }
    const doubled = await fileDoublePayment(db, intent, await purchasesSince(db, intent), Date.parse(intent.paid_detected_at || ''))
    if (!doubled?.approval_id) return { filed: false }
    const { data, error } = await db.from(INTENTS)
      .update({ outcome: { ...(intent.outcome || {}), double_payment: doubled }, updated_at: new Date(now).toISOString() })
      .eq('id', intent.id)
      .eq('status', intent.status)
      .select('id')
    if (error || !Array.isArray(data) || data.length === 0) {
      logWarn(LOG_MODULE, 'double payment card not recorded on the intent', { locationId: intent.location_id, op: 'double_payment_note', intentId: intent.id, status: null, code: error?.code ?? null })
    }
    return { filed: true }
  } catch (err) {
    logError(LOG_MODULE, 'double payment re-check threw', { op: 'double_payment_recheck', intentId, status: null, errClass: err?.name ?? null })
    return { filed: false }
  }
}

/**
 * The silent expiry sweep: every live intent more than EXPIRY_GRACE_MS past
 * expires_at becomes 'expired' (CAS on status and expiry), which frees the
 * member for a new link. Inside the grace the watcher keeps settling it from
 * the mirror (a payment dated inside the window is booked). Nothing is sent and nothing filed (MIA-EXPIRY-QUIET). Paged under the
 * 1,000-row cap with an explicit order; an expired row leaves the filter, so
 * each page is read from the top. The watcher cron (Task 23) settles
 * each live intent first.
 *
 * @param {object} db service-role client
 * @param {{ now?: number, pageSize?: number }} [opts]
 * @returns {Promise<{ expired: number, error?: true }>}
 */
export async function expireStaleIntents(db, { now = Date.now(), pageSize = EXPIRE_PAGE } = {}) {
  const nowIso = new Date(now).toISOString()
  const cutoffIso = new Date(now - EXPIRY_GRACE_MS).toISOString()
  let expired = 0
  try {
    for (;;) {
      const { data: rows, error } = await db.from(INTENTS)
        .select('id')
        .eq('status', LIVE)
        .lt('expires_at', cutoffIso)
        .order('expires_at', { ascending: true })
        .order('id', { ascending: true })
        .range(0, pageSize - 1)
      if (error) {
        logWarn(LOG_MODULE, 'expiry sweep read failed', { op: 'expire_read', status: null, code: error.code ?? null, expired })
        return { expired, error: true }
      }
      const ids = (Array.isArray(rows) ? rows : []).map((r) => r.id).filter(Boolean)
      if (!ids.length) return { expired }
      const { data: done, error: writeError } = await db.from(INTENTS)
        .update({ status: 'expired', updated_at: nowIso })
        .in('id', ids)
        .eq('status', LIVE)
        .lt('expires_at', cutoffIso)
        .select('id')
      if (writeError) {
        logError(LOG_MODULE, 'expiry sweep write failed', { op: 'expire_write', status: null, code: writeError.code ?? null, expired })
        return { expired, error: true }
      }
      const n = Array.isArray(done) ? done.length : 0
      expired += n
      // Nothing moved (every row settled between the read and the write) or a short page: done.
      if (n === 0 || ids.length < pageSize) return { expired }
    }
  } catch (err) {
    logError(LOG_MODULE, 'expiry sweep threw', { op: 'expire', status: null, errClass: err?.name ?? null, expired })
    return { expired, error: true }
  }
}

// ── check_my_purchase and the answers the model reads after a settle ─

const NEVER_REPEAT = 'Do not repeat it, and never send a link.'
const PAID_NEXT = Object.freeze({
  paid_booked: 'Never offer anything more to buy for this class.',
  paid_class_gone: 'If they want another class, offer one from list_upcoming_classes and book it with book_class.',
  paid_booking_failed: 'The team has been asked to book it: never say it is booked.',
  paid_no_class: 'If they want a class, offer to book one now: list_upcoming_classes, then book_class.',
})
export const ALREADY_SETTLED = Object.freeze({
  paid: true,
  open_intent: false,
  message: 'Their payment has just been picked up, and the confirmation goes to them in this chat. Do not repeat it or say anything about the class yet; if they ask, say they will hear in a moment, or offer to hand off to the team. Never send a link.',
})
export const PAYMENT_PENDING = Object.freeze({
  link_sent: false,
  paid: false,
  payment_pending: true,
  message: 'A payment shows on their account, but it is still being matched to their payment link, so no new link was made and nothing was booked from it yet. Say it can take a few minutes to confirm and offer to hand off to the team. Never say it has gone through, never send a link.',
})
const PURCHASE_UNREADABLE = Object.freeze({
  paid: false,
  error: 'purchase_unreadable',
  message: 'Their payment could not be checked just now. Never say it has or has not gone through: say a payment can take a few minutes to show, and offer to hand off to the team.',
})

/** What the model hears after a settle that paid: the text the member got, or the text to relay. */
export function paidAnswer(settled, product, intentId) {
  const next = PAID_NEXT[settled.outcome]
  return {
    paid: true,
    outcome: settled.outcome,
    booked: settled.outcome === 'paid_booked',
    product,
    intent_id: intentId,
    told: settled.sent === true,
    text: settled.text,
    message: settled.sent
      ? `Their payment went through and they have just been sent this in the chat: "${settled.text}". ${NEVER_REPEAT} ${next}`
      : `Their payment went through. Tell them, staying close to this wording: "${settled.text}". Never send a link. ${next}`,
  }
}

/**
 * check_my_purchase: the member says they paid. The member's live intent is
 * settled now (detected_by 'tool', the live entitlement); paid answers carry
 * the purchase_paid_* text (already sent in the thread, so the model does not
 * repeat it); not yet is neutral; no live intent is { open_intent: false }.
 *
 * @param {object} ctx tool context
 * @param {import('./member-studios').MemberStudio} studio the answerable un1t.online studio
 * @param {{ now?: () => number }} [deps]
 */
export async function checkMyPurchase(ctx, studio, deps = {}) {
  const { now = () => Date.now() } = deps
  if (!ctx?.verifiedContactId) return { ...NOT_VERIFIED }
  if (!studio?.un1tUserId) return { paid: false, open_intent: false, message: NOT_LINKED_MESSAGE }
  const live = await readMemberLiveIntent(ctx.db, studio, 'id, product_title')
  if (live.error) return { ...PURCHASE_UNREADABLE }
  if (!live.intent) {
    return {
      paid: false,
      open_intent: false,
      message: 'No payment link is open for them. Never say a payment has gone through. If they say they have paid, say it can take a few minutes to show, and offer to hand off to the team.',
    }
  }
  const product = String(live.intent.product_title || '').trim() || 'their purchase'
  const settled = await settlePurchaseIntent(ctx.db, live.intent.id, { detectedBy: 'tool', source: 'live', now })
  if (PAID_OUTCOMES.has(settled.outcome)) return paidAnswer(settled, product, live.intent.id)
  if (settled.outcome === 'already_settled') return { ...ALREADY_SETTLED }
  if (settled.outcome === 'refused') {
    return {
      paid: false,
      open_intent: false,
      message: 'Their payment link could not be made, so there is nothing to pay on it and nothing was booked. Never say a payment has gone through. Offer to hand off to the team.',
    }
  }
  if (settled.outcome === 'not_paid') {
    return {
      paid: false,
      open_intent: true,
      product,
      intent_id: live.intent.id,
      message: `Their payment for ${product} is not showing yet. A payment can take a few minutes to show, so never say it has gone through. Say you will confirm here as soon as it shows, or offer to hand off to the team.`,
    }
  }
  if (settled.outcome === 'expired') {
    return {
      paid: false,
      open_intent: false,
      expired: true,
      message: settled.payment_seen
        ? 'Their payment link lapsed before a payment for it could be confirmed, so nothing was booked from it. Never say it has gone through or that a class is booked: say the team will check their account, and offer to hand off.'
        : 'Their payment link has lapsed and no payment for it shows, so nothing was booked. Never say it has gone through. Offer a new link with send_purchase_link, or to hand off to the team.',
    }
  }
  return { ...PURCHASE_UNREADABLE }
}
