// WA-MULTI.1 — per-location WhatsApp configuration resolution.
//
// Single entry point for "give me the WhatsApp credentials I should
// use for this location". Resolution, in order:
//
//   1. whatsapp_numbers row for this location, is_default=true.
//      Multi-number locations (e.g. CRM-driven broadcasts via
//      Cloud API + an operator's mobile via coexistence) pick the
//      default for outbound; per-call overrides (passing a specific
//      number_id) skip this tier.
//
//   2. whatsapp_numbers row for this location, is_default=false but
//      is_active=true and at least one exists. Picks the most-
//      recently-updated one. Safety net so a location with WA rows
//      but no default still works.
//
//   Nothing else. WACONFIGFALLBACK.1 retired the third tier (the global
//   WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID env number): a
//   location with no active row of its own now gets a
//   WhatsAppNumberMissingError (./whatsapp-number-missing.js), never
//   another studio's number. Per-location comms model: row absent = may
//   never send. Each caller's decision is tabled in
//   tests/whatsapp-config-callers.test.js.
//
// The webhook router (`resolveWhatsAppNumberByPhoneNumberId`)
// goes the other direction — given the phone_number_id Meta sent
// in the inbound payload, find the location that owns it.

import { createServerClient } from './supabase'
import { WhatsAppNumberMissingError } from './whatsapp-number-missing'

const META_API_VERSION = 'v21.0'
export const META_API_URL = `https://graph.facebook.com/${META_API_VERSION}`

/**
 * Map a whatsapp_numbers row to the config shape callers expect.
 */
function rowToConfig(row) {
  return {
    source: 'db',
    id: row.id,
    locationId: row.location_id,
    label: row.label,
    token: row.access_token,
    phoneNumberId: row.phone_number_id,
    businessAccountId: row.business_account_id || null,
    appId: row.app_id || null,
    displayPhone: row.display_phone || null,
    sourceKind: row.source,        // 'cloud_api' | 'coexistence'
    // WA-QUALITY.2 — Meta quality rating as of the last webhook/poll
    // (GREEN/YELLOW/RED, null = never fetched). sendBroadcast's preflight
    // gate reads this.
    qualityRating: row.quality_rating ?? null,
    // WA-BUDGET — Meta messaging-limit tier as of the last webhook/poll
    // (TIER_250 … UNLIMITED, null = never fetched). The blast/drip tier-budget
    // gates read this.
    messagingLimitTier: row.messaging_limit_tier ?? null,
  }
}

/**
 * WAROLE.1 — the location's OWN number (tiers 1-2). Returns null when the
 * location has no active whatsapp_numbers row (or no location id is given);
 * throws when the lookup itself fails, so a DB blip is never read as "no
 * number". Routes that act AT META for a location use it through
 * ownNumberOrRefusal (./whatsapp-own-number.js) to answer 409 / 500 before
 * any Meta call.
 *
 * @param {string | null | undefined} locationId
 * @returns {Promise<object | null>}
 */
export async function getLocationWhatsAppNumberConfig(locationId) {
  if (!locationId) return null
  const db = createServerClient()
  const { data: rows, error } = await db
    .from('whatsapp_numbers')
    .select('*')
    .eq('location_id', locationId)
    .eq('is_active', true)
    .order('is_default', { ascending: false })   // default first
    .order('updated_at', { ascending: false })   // then newest
    .limit(1)

  if (error) {
    throw new Error(`Failed to load WhatsApp config for location ${locationId}: ${error.message}`)
  }
  return rows && rows.length > 0 ? rowToConfig(rows[0]) : null
}

/**
 * Resolve the WhatsApp config to use for outbound sends from
 * `locationId`: the location's own active number (default first).
 *
 * WACONFIGFALLBACK.1 — there is no env tier any more. A location with no
 * active whatsapp_numbers row, or no location at all, throws
 * WhatsAppNumberMissingError (code WA_NO_NUMBER): the caller decides what
 * that means for it (see tests/whatsapp-config-callers.test.js). A failed
 * lookup throws a plain Error, so a DB blip is never read as "no number".
 *
 * @param {string | null | undefined} locationId
 * @returns {Promise<object>}  Config object with .token + .phoneNumberId
 *   at minimum.
 */
export async function getWhatsAppConfig(locationId) {
  const own = await getLocationWhatsAppNumberConfig(locationId)
  if (own) return own
  throw new WhatsAppNumberMissingError(locationId)
}

/**
 * Resolve by a SPECIFIC whatsapp_numbers.id — used when a caller
 * wants to send from a non-default number (e.g. multi-number
 * location and the operator picked one in the inbox).
 */
export async function getWhatsAppConfigById(numberId) {
  if (!numberId) throw new Error('getWhatsAppConfigById requires a numberId.')
  const db = createServerClient()
  const { data: row, error } = await db
    .from('whatsapp_numbers')
    .select('*')
    .eq('id', numberId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw new Error(`Failed to load WhatsApp number ${numberId}: ${error.message}`)
  if (!row) throw new Error(`WhatsApp number ${numberId} not found or inactive.`)
  return rowToConfig(row)
}

/**
 * Reverse lookup for the inbound webhook router. Meta's webhook
 * payload includes the destination phone_number_id; we map it back
 * to the owning location + config so the inbox knows where to drop
 * the message.
 *
 * Returns null ONLY when the phone_number_id is authoritatively
 * unknown (no active row). Throws when the lookup itself fails
 * (transient DB error) — callers must treat a throw as "owner
 * undetermined", never as "unknown number", so the two cases stay
 * separately loggable (WA-TECHPROV.4b). WACONFIGFALLBACK.1: the env
 * number is no longer consulted; it could only ever produce a config
 * with no location, which classifyInboundOwner drops anyway.
 */
export async function resolveWhatsAppNumberByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null

  const db = createServerClient()
  const { data: row, error } = await db
    .from('whatsapp_numbers')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) {
    // A transient lookup error must NEVER be reported as "unknown number"
    // (null): the webhook drops unknowns, and a dropped message is
    // permanently lost (we 200 + dedup, so Meta never retries). Throw so the
    // webhook logs a resolver failure, not an unknown number.
    console.warn('[wa-config] phone_number_id lookup failed:', error.message)
    throw new Error(`whatsapp_numbers lookup failed: ${error.message}`)
  }
  return row ? rowToConfig(row) : null
}

/**
 * WA-TECHPROV.4 / SAAS-2 — inbound routing decision for the webhook.
 *
 * Only an active whatsapp_numbers row may own inbound traffic. Anything
 * else — an unknown phone_number_id, or any config without a location —
 * is dropped by the webhook. The historical first-location
 * fallback routed a foreign number's messages (and the contact + Mia
 * reply they spawned) into an arbitrary tenant.
 */
export function classifyInboundOwner(owningNumber) {
  if (owningNumber?.source === 'db' && owningNumber.locationId) {
    return { action: 'location', locationId: owningNumber.locationId }
  }
  return { action: 'drop' }
}
