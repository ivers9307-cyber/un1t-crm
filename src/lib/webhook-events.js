// Webhook dedup helper.
//
// Single chokepoint that every webhook handler hits at the top of
// the request. Inserts a (provider, event_id) row; if the unique
// constraint fires the second-arriving copy short-circuits with
// `seen=true` and the route returns early without doing duplicate
// work.
//
// Why this exists
//   Postmark, Revolut, WhatsApp + Twilio all retry webhooks on
//   non-2xx responses for hours-to-days. Our existing per-feature
//   idempotency (status comparisons in the cars / race-payments
//   paths, *_sent_at stamps in the confirmation paths) is good but
//   distributed — easy to miss a path when a new feature lands.
//   This is the belt-and-braces layer.
//
// Race-safety
//   Two simultaneous webhook posts (same event_id) will both try
//   to INSERT. Postgres serialises them via the unique index — the
//   first commits, the second fails with code 23505. We catch the
//   23505 and return seen=true. Service-role bypasses RLS, so the
//   insert never silently fails to a missing-policy check.
//
// Cost
//   One INSERT per webhook. The unique index makes the conflict
//   path O(log n) on the small lookup we need. Rows older than 90d
//   get pruned by a future TTL cron.

import { logWarn } from './log'

export const WEBHOOK_PROVIDERS = Object.freeze({
  POSTMARK: 'postmark',
  REVOLUT: 'revolut',
  REVOLUT_RACE: 'revolut_race',
  WHATSAPP: 'whatsapp',
  TWILIO: 'twilio',
  XERO: 'xero',
  // Mig 120: UniFi Access door-unlock events — drives zero-touch
  // staff attendance tracking. Provider whitelist updated in mig 120.
  UNIFI_ACCESS: 'unifi_access',
})

const VALID_PROVIDERS = new Set(Object.values(WEBHOOK_PROVIDERS))

const PG_UNIQUE_VIOLATION = '23505'

/**
 * Attempt to record a webhook event. Returns whether we've seen it
 * before (in which case the caller should short-circuit) and any
 * underlying error so the caller can log without crashing.
 *
 * Defensive defaults: if `provider` or `eventId` is missing/invalid
 * we return `{ seen: false, error: 'invalid_input' }` rather than
 * throwing — the route should still process the event in that case
 * (we don't want a malformed payload to silently no-op revenue).
 *
 * @param {object} args
 * @param {object} args.db        Supabase service-role client
 * @param {string} args.provider  One of WEBHOOK_PROVIDERS values
 * @param {string} args.eventId   Provider-specific composite key,
 *                                see mig 107 header for the shape.
 * @returns {Promise<{ seen: boolean, error?: string }>}
 */
export async function recordWebhookEvent({ db, provider, eventId }) {
  if (!db) return { seen: false, error: 'invalid_input' }
  if (!VALID_PROVIDERS.has(provider)) return { seen: false, error: 'invalid_input' }
  if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > 512) {
    return { seen: false, error: 'invalid_input' }
  }

  const { error } = await db
    .from('webhook_events')
    .insert({ provider, event_id: eventId })

  if (!error) {
    return { seen: false }
  }

  // 23505 = unique_violation. The composite (provider, event_id)
  // already exists → caller should short-circuit.
  if (error.code === PG_UNIQUE_VIOLATION) {
    return { seen: true }
  }

  // Unexpected DB error. Don't drop the webhook — let the caller
  // continue and rely on the existing per-feature idempotency.
  // But log it so a sustained failure becomes visible in Sentinel.
  logWarn('webhook-events', 'insert failed', { provider, eventId, err: error })
  return { seen: false, error: error.message }
}
