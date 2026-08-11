// UNSUB-RL.1 — abuse protection for the public consent-token endpoints
// (`/api/unsubscribe/[token]`, `/api/preferences/[token]`).
//
// ─── WHAT WAS WRONG ────────────────────────────────────────────────────────
// Both routes opened with a per-IP fixed-window limiter (unsubscribe: 10 per
// 15 min; preferences: 20). That is the wrong axis for these endpoints, and
// on the unsubscribe route it is a compliance defect, not a tuning problem.
//
// An RFC 8058 one-click unsubscribe POST is issued by the RECIPIENT'S MAIL
// PROVIDER, not by the recipient's browser. Gmail sends them from a shared
// proxy pool, so N different people unsubscribing from ONE campaign can all
// arrive at us from one source IP inside one window. Under a per-IP limit the
// 11th of those is refused with a 429 — and because the limiter ran before the
// token was even looked at, the route returned having written nothing at all.
// The person is still on the list, believes they unsubscribed, and there is no
// record anywhere that it happened.
//
// Both Gmail's and Yahoo's bulk-sender requirements oblige us to honour these,
// and GDPR/PECR oblige us to honour a withdrawal of consent. Measured live:
// 9 one-click unsubscribes landed in a single 15-minute window on 2026-08-05,
// against a limit of 10.
//
// ─── WHAT THE OLD LIMITER WAS ACTUALLY DEFENDING ───────────────────────────
// Three things, and they are worth naming because the replacement has to keep
// covering all three:
//   1. TOKEN ENUMERATION — an unauthenticated caller walking the token space.
//   2. UNAUTHENTICATED DB LOAD — every request costs a `contact_preferences`
//      lookup (plus writes) on the service-role client, with no cost to the
//      caller.
//   3. A MISCONFIGURED MAIL CLIENT looping on one unsubscribe URL (the
//      original code comment's stated motive).
//
// ─── THE REPLACEMENT ───────────────────────────────────────────────────────
// The token IS the credential. `contact_preferences.unsubscribe_token` is a
// v4 UUID — 122 bits of entropy — minted per contact by mig 005, and it names
// exactly one contact. So split the callers into the two populations the old
// limiter conflated:
//
//   • Token does NOT resolve → this caller is guessing. Budget them PER IP
//     (`<scope>:invalid:<ip>`). Covers (1) and (2): a brute-forcer produces
//     nothing but invalid tokens, so they exhaust the budget in ~20 requests
//     and every subsequent request is refused before it touches the database.
//     This is a STRICTLY TIGHTER enumeration defence than the old one, which
//     spent the same budget on legitimate holders and therefore had to be set
//     loose enough not to break them.
//
//   • Token DOES resolve → this caller holds a per-contact capability.
//     Budget them PER TOKEN (`<scope>:token:<fingerprint>`), with no IP
//     component at all, so a shared provider proxy can never trip it. Covers
//     (3): a looping client hammers one token and is capped on that token,
//     while every other recipient behind the same proxy is untouched.
//
// Because the two budgets are keyed differently, exhausting one cannot deny
// the other. And because a repeat opt-out for an already-opted-out contact is
// a no-op success (see the route), the common "provider retries the POST"
// case never even reaches a write.
//
// ─── AND EVERY REFUSAL IS RECORDED ─────────────────────────────────────────
// The old failure mode's worst property was that it was unmeasurable: a 429
// wrote nothing, so "how many opt-outs did we drop" had no answer. Every
// refusal now goes to `unsubscribe_refusals` (mig 522) AND to the structured
// log, best-effort in both directions — see recordRefusedOptOut.

import crypto from 'node:crypto'
import { peekRateLimit, checkRateLimit } from './rate-limit.js'
import { logError } from './log.js'

/**
 * Per-IP budget, spent ONLY by callers whose token did not resolve.
 * Deliberately small: a legitimate caller never lands here even once, so
 * there is no population this can be tuned "too tight" for.
 */
export const INVALID_TOKEN_RL = Object.freeze({ max: 20, windowMs: 15 * 60_000 })

/**
 * Per-token budget for a caller holding a valid capability. Generous, because
 * one token is one human: the preference centre does a GET plus a handful of
 * PUTs per visit, and a one-click unsubscribe is a single POST. Anything
 * approaching this ceiling is a looping client, which is the only thing this
 * tier exists to blunt.
 */
export const PER_TOKEN_RL = Object.freeze({ max: 60, windowMs: 15 * 60_000 })

/** Why an opt-out request was refused. Stored verbatim in unsubscribe_refusals.reason. */
export const REFUSAL_REASONS = Object.freeze({
  /** Caller had already burned the per-IP invalid-token budget. */
  IP_ENUMERATION: 'ip_enumeration_budget',
  /** Token did not resolve to a contact_preferences row. */
  INVALID_TOKEN: 'invalid_token',
  /** A single token exceeded PER_TOKEN_RL — a looping client, not a person. */
  TOKEN_FLOOD: 'token_flood',
})

/**
 * A stable, non-reversible handle for a token.
 *
 * Used for BOTH the rate-limit bucket key and the audit row, so that the live
 * credential never lands in `rate_limit_buckets.bucket_key` or in
 * `unsubscribe_refusals` — either of which would turn a debugging table into a
 * store of working unsubscribe links for real contacts.
 *
 * 128 bits of the SHA-256 is far more than enough to keep two tokens apart
 * while keeping the key short.
 *
 * @param {string|null|undefined} token
 * @returns {string|null}
 */
export function tokenFingerprint(token) {
  if (typeof token !== 'string' || !token) return null
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 32)
}

/**
 * Pre-lookup gate. PEEKS the per-IP invalid-token budget — it must not spend
 * from it, because at this point we do not yet know which population the
 * caller belongs to, and charging a valid holder is the entire defect.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {'unsubscribe'|'preferences'} scope
 * @param {string} ip
 */
export function guardBeforeTokenLookup(db, scope, ip) {
  return peekRateLimit(db, `${scope}:invalid:${ip}`, INVALID_TOKEN_RL)
}

/**
 * Charge the per-IP budget peeked above. Called only once we know the token
 * did not resolve.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {'unsubscribe'|'preferences'} scope
 * @param {string} ip
 */
export function penaliseInvalidToken(db, scope, ip) {
  return checkRateLimit(db, `${scope}:invalid:${ip}`, INVALID_TOKEN_RL)
}

/**
 * Post-lookup gate for a caller who presented a token that resolves.
 *
 * Keyed on the token fingerprint ALONE. No IP component, deliberately — the
 * whole point is that a mail provider's shared egress IP is invisible here.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {'unsubscribe'|'preferences'} scope
 * @param {string} token
 */
export function guardResolvedToken(db, scope, token) {
  return checkRateLimit(db, `${scope}:token:${tokenFingerprint(token)}`, PER_TOKEN_RL)
}

/**
 * Record a consent request we refused.
 *
 * A refused opt-out is a compliance event: somebody asked to stop being
 * marketed to and we did not action it. Before this existed the event was
 * completely invisible — a 429 with no write — so nobody could even count
 * them, let alone go back and honour them. `unsubscribe_refusals` (mig 522)
 * is the queryable record; the log line is the belt-and-braces copy that
 * survives the table not being there yet.
 *
 * FAIL-SOFT IN BOTH DIRECTIONS, on purpose. This runs on the path of a
 * request we are already refusing; a throw here would replace a 429 with a
 * 500 and add nothing. It also means the code is safe to deploy ahead of
 * mig 522 — the insert fails, the log line still lands.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {{
 *   endpoint: 'unsubscribe'|'preferences',
 *   reason: string,
 *   ip?: string|null,
 *   token?: string|null,
 *   contactId?: string|null,
 *   locationId?: string|null,
 *   campaignId?: string|null,
 *   channels?: string[]|null,
 *   userAgent?: string|null,
 * }} details
 * @returns {Promise<void>}
 */
export async function recordRefusedOptOut(db, details) {
  const {
    endpoint, reason, ip = null, token = null, contactId = null,
    locationId = null, campaignId = null, channels = null, userAgent = null,
  } = details || {}

  const row = {
    endpoint,
    reason,
    contact_id: contactId,
    location_id: locationId,
    campaign_id: campaignId,
    channels: channels && channels.length ? channels : null,
    ip_address: ip,
    user_agent: userAgent,
    token_fingerprint: tokenFingerprint(token),
  }

  // Always log — this is the copy that works before mig 522 is applied, and
  // the one Sentinel can alert on.
  logError('consent-refusal', 'refused a consent request', {
    endpoint, reason, contactId, campaignId, ip,
  })

  try {
    const { error } = await db.from('unsubscribe_refusals').insert(row)
    if (error) {
      console.error('[consent-refusal] could not persist refusal:', error.message)
    }
  } catch (err) {
    console.error('[consent-refusal] persisting refusal threw:', err?.message || err)
  }
}
