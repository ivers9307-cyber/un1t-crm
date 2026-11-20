// RAFFLE.3 — raffle tickets bought online on the public event page.
//
// Spec: docs/superpowers/specs/2026-11-20-charity-raffle-design.md (RAFFLE.3).
//
// The lifecycle mirrors a card donation (src/lib/donation-payments.js):
//   the public route inserts a raffle_orders row `awaiting_payment`, opens a
//   Revolut order and hands the checkout to the page; the status poll, the
//   Revolut donations webhook (unknown donation refs fall through to here) and
//   the reconcile job call markRaffleOrderPaymentStatus(); every observation of
//   a PAID order runs runPaidRaffleOrderEffects().
//
// THE DIFFERENCE FROM DONATIONS: a paid raffle order never links or creates a
// contact, tag, consent or timeline event. The buyer is a guest, as at the
// till (Richard's rule: the raffle never touches profiles or pipelines).
//
// Effects are idempotent on their own stamps: issue_raffle_order_tickets
// (mig 866) numbers the tickets once (order.sale_id), and the email goes once,
// to the observer that wins the email_claimed_at compare-and-set.

import { paymentsFor } from '@/lib/payments'
import { resolvePaymentProvider } from '@/lib/event-hosts'
import { getLocationBranding } from '@/lib/location-branding'
import { sendRaffleTicketsEmail } from '@/lib/raffle-email'
import { RAFFLE_COLS } from '@/lib/raffle'
import { formatInZone } from '@/lib/location-time'
import { logError, logWarn } from '@/lib/log'

const PROVIDER_REVOLUT = 'revolut'
export const ONLINE_MAX_TICKETS = 50

export const RAFFLE_ORDER_COLS = [
  'id', 'raffle_id', 'race_event_id', 'location_id', 'buyer_name', 'buyer_email', 'quantity',
  'amount_cents', 'currency', 'option_label', 'status', 'payment_provider', 'payment_provider_ref',
  'payment_checkout_token', 'payment_checkout_url', 'paid_at', 'sale_id', 'email_claimed_at', 'created_at',
].join(', ')

/** The race_events columns the paid effects (the ticket email) read. */
export const RAFFLE_ORDER_EVENT_COLS = 'id, name, location_id, host_id, sending_location_id, accent_hex, hero_image_url'

const IMMOVABLE = new Set(['paid', 'refunded'])
const TERMINAL_FAILURE = new Set(['failed', 'expired'])

/**
 * Is the raffle selling online right now?
 * @returns {{ open: boolean, reason: null|'off'|'closed' }}
 */
export function onlineSalesState(raffle, nowMs = Date.now()) {
  if (!raffle?.online_enabled || !raffle.sales_open) return { open: false, reason: 'off' }
  if (raffle.online_closes_at && Date.parse(raffle.online_closes_at) <= nowMs) return { open: false, reason: 'closed' }
  return { open: true, reason: null }
}

/**
 * The display-safe raffle block the public event page reads, or null when
 * online sales are switched off. Nothing about buyers, sales or totals.
 */
export function publicRaffleBlock(raffle, zone, nowMs = Date.now()) {
  if (!raffle) return null
  const state = onlineSalesState(raffle, nowMs)
  if (state.reason === 'off') return null
  return {
    name: raffle.name,
    currency: raffle.currency || 'EUR',
    ticket_price_cents: raffle.ticket_price_cents,
    ticket_options: (raffle.ticket_options || []).filter((o) => Number(o.tickets) <= ONLINE_MAX_TICKETS),
    max_tickets: ONLINE_MAX_TICKETS,
    open: state.open,
    closes_at: raffle.online_closes_at || null,
    closes_label: raffle.online_closes_at
      ? formatInZone(raffle.online_closes_at, zone, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true })
      : null,
  }
}

/** The event's raffle for the public routes, or null. */
export async function loadRaffleForEvent(db, race) {
  const { data, error } = await db.from('raffles').select(RAFFLE_COLS)
    .eq('race_event_id', race.id).eq('location_id', race.location_id).maybeSingle()
  if (error) throw error
  return data || null
}

/** "UN1T Stillorgan: Raffle tickets (3)" on the checkout and the statement. */
export function raffleOrderDescription(brand, quantity) {
  const what = `Raffle ticket${Number(quantity) === 1 ? '' : 's'} (${quantity})`
  const b = String(brand || '').trim()
  return b ? `${b}: ${what}` : what
}

/**
 * Open a Revolut order for an inserted `awaiting_payment` row and persist its
 * refs. The amount is the row's (priced on the server), never a client value.
 * Throws `payments_unavailable` for a third-party host's event (Stripe
 * Connect is not wired for raffles), and throws if the ref cannot be stored:
 * a checkout nothing could ever settle must not be handed out.
 */
export async function createRaffleOrderPayment({ db, order, race, host, returnUrl }) {
  if (resolvePaymentProvider(host) !== PROVIDER_REVOLUT) {
    const err = new Error('payments_unavailable')
    err.code = 'payments_unavailable'
    throw err
  }
  const { companyName } = await getLocationBranding(db, race.location_id)
  const created = await paymentsFor(PROVIDER_REVOLUT).createPayment({
    amountCents: order.amount_cents,
    currency: order.currency || 'EUR',
    description: raffleOrderDescription(companyName, order.quantity),
    returnUrl,
    metadata: { raffle_order_id: order.id, domain: 'un1t_raffle', race_event_id: race.id, location_id: race.location_id },
    idempotencyKey: order.id,
    customer: { email: order.buyer_email, fullName: order.buyer_name },
    merchantReference: `raffle:${order.id}`,
    statementDescriptorSuffix: 'RAFFLE',
    connectedAccountId: null,
    applicationFeeCents: 0,
  })
  const { error } = await db.from('raffle_orders')
    .update({
      payment_provider: PROVIDER_REVOLUT,
      payment_provider_ref: created.providerRef,
      payment_checkout_token: created.checkoutToken || null,
      payment_checkout_url: created.checkoutUrl || null,
    })
    .eq('id', order.id)
  if (error) throw new Error(`Failed to persist payment ref for raffle order ${order.id}: ${error.message}`)
  return {
    orderId: order.id,
    checkout: { provider: PROVIDER_REVOLUT, token: created.checkoutToken || null, url: created.checkoutUrl || null, connectedAccountId: null },
  }
}

/** Webhook lookup: the order that owns this provider ref (null when none). */
export async function resolveRaffleOrderByRef(db, providerRef) {
  if (!providerRef) return null
  const { data, error } = await db.from('raffle_orders').select(RAFFLE_ORDER_COLS).eq('payment_provider_ref', providerRef).maybeSingle()
  if (error) throw error
  return data || null
}

/**
 * Apply a provider state change, compare-and-set on the status it leaves.
 * Returns { status, changed }. A completion after a failure report is still
 * marked paid: the money was taken.
 */
export async function markRaffleOrderPaymentStatus({ db, order, providerState, providerAmount, now = () => new Date().toISOString() }) {
  if (IMMOVABLE.has(order?.status)) return { status: order.status, changed: false }
  const state = String(providerState || '').toLowerCase()

  let target = null
  let updates = null
  if (state === 'completed') {
    target = 'paid'
    updates = { status: 'paid', paid_at: now() }
    if (Number.isFinite(providerAmount) && providerAmount > 0 && providerAmount !== order.amount_cents) {
      logError('raffle-online', 'provider amount differs from the order; recording what was paid', { orderId: order.id, ordered: order.amount_cents, paid: providerAmount })
      updates.amount_cents = providerAmount
    }
  } else if (TERMINAL_FAILURE.has(order?.status)) {
    return { status: order.status, changed: false }
  } else if (state === 'failed' || state === 'cancelled' || state === 'expired') {
    target = state === 'failed' ? 'failed' : 'expired'
    updates = { status: target }
  } else {
    return { status: order.status, changed: false }
  }

  const { data, error } = await db.from('raffle_orders')
    .update(updates).eq('id', order.id).eq('status', order.status).select('id')
  if (error) throw error
  if (Array.isArray(data) && data.length === 0) {
    const { data: current, error: readErr } = await db.from('raffle_orders').select('status').eq('id', order.id).maybeSingle()
    if (readErr) throw readErr
    return { status: current?.status || order.status, changed: false }
  }
  if (target === 'paid' && TERMINAL_FAILURE.has(order.status)) {
    logError('raffle-online', 'completed after a terminal failure report; marked paid', { orderId: order.id, from: order.status })
  }
  return { status: target, changed: true }
}

/**
 * Everything that follows a paid order: number the tickets (once) and send the
 * ticket email (once). Safe on every observation. Never throws.
 * @returns {Promise<{ tickets: 'issued'|'failed'|'skipped', email: string, sale: object|null }>}
 */
export async function runPaidRaffleOrderEffects({ db, order }) {
  const out = { tickets: 'skipped', email: 'skipped', sale: null }
  if (order?.status !== 'paid') return out
  let sale = null
  try {
    const { data, error } = await db.rpc('issue_raffle_order_tickets', { p_order_id: order.id })
    if (error) throw error
    sale = data
    out.tickets = 'issued'
    out.sale = sale
  } catch (e) {
    out.tickets = 'failed'
    logError('raffle-online', 'PAID raffle order has no tickets yet; the next observation retries', { err: e, orderId: order.id })
    return out
  }

  try {
    const { data: claimed, error } = await db.from('raffle_orders')
      .update({ email_claimed_at: new Date().toISOString() })
      .eq('id', order.id).is('email_claimed_at', null).select('id')
    if (error) throw error
    if (!claimed?.length) { out.email = 'already_claimed'; return out }

    const [{ data: raffle, error: rErr }, { data: race, error: eErr }] = await Promise.all([
      db.from('raffles').select(RAFFLE_COLS).eq('id', order.raffle_id).maybeSingle(),
      db.from('race_events').select(RAFFLE_ORDER_EVENT_COLS).eq('id', order.race_event_id).maybeSingle(),
    ])
    if (rErr || eErr || !raffle || !race) throw rErr || eErr || new Error('raffle or event row missing')
    const sent = await sendRaffleTicketsEmail({ db, sale, raffle, race })
    out.email = sent.status
  } catch (e) {
    out.email = 'failed'
    logWarn('raffle-online', 'ticket email step failed; the sale shows the email status for staff', { err: e, orderId: order.id })
  }
  return out
}
