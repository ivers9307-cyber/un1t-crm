// HATCHTRACK.1 — the paid trial's Meta Purchase, one definition for both
// studios, and the browser details it needs.
//
// The Purchase is sent from a worker (Stillorgan: the grant; Hatch Street: the
// settle sweep), where there is no request, so it used to go without the
// buyer's IP address, user agent and often click id: Meta scored the Hatch
// Purchase 6.6 for match quality against 9.3 at Stillorgan, whose browser copy
// carries them. They are now captured when the checkout is created (the same
// request that already sends them to Meta on the Lead) and kept on
// `trial_purchases.attribution` only until the Purchase is sent or the
// checkout ends unpaid:
//
//   client_ip          the request's IP address
//   client_user_agent  its user agent (cut to 512)
//
// That is personal data at rest. The rules that go with it:
//   - nothing but the Purchase reads them (the Schedule / Subscribe follow-ups
//     days later never do);
//   - they leave the row IN THE SAME WRITE that marks it granted (the
//     Purchase is then sent from the row the worker already holds in memory),
//     and in the write that marks an unpaid checkout failed or expired. Never
//     in a write of their own after the grant: `attribution` is written whole,
//     and the follow-ups stamp `meta_*_sent_at` into it once a row is granted,
//     so a later whole-object write from a stale copy could erase a stamp and
//     send a Schedule twice;
//   - no public route returns `attribution` (the status route names its
//     columns; `src/app/api/public/trial-purchases/[id]/route.test.js` pins it);
//   - `trial_purchases` is not an audited table, so nothing copies them on.
import { sendWebsiteConversion } from '@/lib/meta-capi'

/** The attribution keys that hold the buyer's browser details. */
export const TRIAL_CLIENT_DATA_KEYS = Object.freeze(['client_ip', 'client_user_agent'])

/** What the checkout request stores: only values CAPI will accept, else nothing. */
export function clientDataForAttribution({ ip, userAgent } = {}) {
  const out = {}
  if (typeof ip === 'string' && ip && ip !== 'unknown' && ip.length <= 64) out.client_ip = ip
  if (typeof userAgent === 'string' && userAgent.trim()) out.client_user_agent = userAgent.trim().slice(0, 512)
  return out
}

/** A copy of an attribution object without the browser details; null when there were none to remove. */
export function withoutClientData(attribution) {
  if (!attribution || typeof attribution !== 'object' || Array.isArray(attribution)) return null
  if (!TRIAL_CLIENT_DATA_KEYS.some((k) => k in attribution)) return null
  const out = { ...attribution }
  for (const k of TRIAL_CLIENT_DATA_KEYS) delete out[k]
  return out
}

// The first-touch values a later attempt takes from the buyer's earlier row
// when it arrived without them (a retry after a cancelled checkout has no
// fbclid in its URL). Never the browser details: those are the request's own.
const INHERITED_KEYS = Object.freeze(['fbc', 'fbp', 'utm_campaign', 'utm_content', 'utm_term', 'utm_source', 'utm_medium', 'ad_provider', 'ad_external_id'])

/** `current` with each missing first-touch value filled from `prior`. Pure. */
export function inheritAttribution(current, prior) {
  const out = { ...(current && typeof current === 'object' ? current : {}) }
  if (!prior || typeof prior !== 'object' || Array.isArray(prior)) return out
  for (const k of INHERITED_KEYS) {
    if (out[k] == null || out[k] === '') {
      const v = prior[k]
      if (typeof v === 'string' && v) out[k] = v
    }
  }
  return out
}

/** The server Purchase for one trial_purchases row: the browser's event id, value and order. */
export function trialPurchaseConversionArgs(row) {
  const a = row?.attribution && typeof row.attribution === 'object' ? row.attribution : {}
  return {
    locationId: row.location_id,
    eventName: 'Purchase',
    email: row.customer_email, phone: row.customer_phone,
    firstName: row.first_name, lastName: row.last_name,
    externalId: row.contact_id,
    eventSourceUrl: a.event_source_url || undefined,
    // The browser's Purchase carries the same id, so Meta counts one.
    eventId: `trialpurchase-${row.id}`,
    contentName: row.product_name,
    // PURCHASEVALUE.1 — what the browser's Purchase already says: the amount
    // taken, its currency, and our purchase id as the order.
    value: (row.amount_cents || 0) / 100, currency: row.currency || 'EUR',
    orderId: row.id, contentType: 'product',
    fbc: a.fbc, fbp: a.fbp,
    clientIp: a.client_ip, userAgent: a.client_user_agent,
  }
}

/**
 * Send the Purchase for a row the worker holds in memory (its `attribution`
 * as read before the grant stamp took the browser details off the stored
 * row). Writes nothing.
 * @returns {Promise<object>} sendWebsiteConversion's answer
 */
export async function sendTrialPurchaseConversion(db, row, { send = sendWebsiteConversion } = {}) {
  return send(db, trialPurchaseConversionArgs(row))
}

/** The fields a grant (or an ending) stamp adds to drop the browser details; {} when the row holds none. */
export function clientDataRemoval(row) {
  const stripped = withoutClientData(row?.attribution)
  return stripped ? { attribution: stripped } : {}
}
