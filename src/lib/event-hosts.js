// Event host (payee) resolution + marketplace fee math (EVENTS-HOST.1).
//
// An event's payments route to a processor decided by its host:
//   - race_events.host_id NULL  → internal UN1T event → Revolut (current behaviour)
//   - host.payment_provider = 'revolut'        → Revolut
//   - host.payment_provider = 'stripe_connect' → Stripe Connect DIRECT charge
//     onto the host's connected account, with a flat per-ticket booking fee
//     (platform_fee_cents × seats) kept by UN1T as the application_fee_amount.
//
// The fee is added ON TOP of the ticket price at checkout (Eventbrite-style),
// so the host receives their full ticket price (less Stripe's own processing
// fee, which the host bears under direct charges).

export const PROVIDER_REVOLUT = 'revolut'
export const PROVIDER_STRIPE_CONNECT = 'stripe_connect'

/**
 * Load the host row for an event, or null for internal (UN1T) events.
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {{ host_id?: string|null }} race  race_events row (must include host_id)
 * @returns {Promise<object|null>}
 */
export async function resolveEventHost(db, race) {
  if (!race?.host_id) return null
  const { data } = await db
    .from('event_hosts')
    .select('*')
    .eq('id', race.host_id)
    .maybeSingle()
  return data || null
}

/**
 * Which payment processor settles this event's money.
 * @param {object|null} host  event_hosts row, or null (internal event)
 * @returns {'revolut'|'stripe_connect'}
 */
export function resolvePaymentProvider(host) {
  if (!host) return PROVIDER_REVOLUT // internal UN1T event
  return host.payment_provider === PROVIDER_STRIPE_CONNECT
    ? PROVIDER_STRIPE_CONNECT
    : PROVIDER_REVOLUT
}

/**
 * The flat per-ticket booking fee UN1T keeps for a stripe_connect host, added
 * on top of the ticket price at checkout. Zero for internal / Revolut events.
 * @param {object|null} host       event_hosts row, or null
 * @param {number} seatCount       number of tickets in this order
 * @returns {number} application fee in minor units (cents), never negative
 */
export function computeApplicationFeeCents(host, seatCount) {
  if (!host || host.payment_provider !== PROVIDER_STRIPE_CONNECT) return 0
  const perTicket = Number(host.platform_fee_cents) || 0
  const seats = Math.max(0, Math.floor(Number(seatCount) || 0))
  return Math.max(0, perTicket * seats)
}

/**
 * Whether a host can currently take money. A stripe_connect host must have
 * completed Stripe onboarding (charges_enabled) before its events can sell
 * paid tickets. Internal/Revolut events are always chargeable.
 * @param {object|null} host
 * @returns {boolean}
 */
export function hostCanTakePayments(host) {
  if (!host) return true // internal UN1T event (Revolut)
  if (host.payment_provider === PROVIDER_STRIPE_CONNECT) return !!host.charges_enabled
  return true
}
