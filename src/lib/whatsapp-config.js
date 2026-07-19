// WA-MULTI.1 — per-location WhatsApp configuration resolution.
//
// Single entry point for "give me the WhatsApp credentials I should
// use for this location". Three resolution tiers, in order:
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
//   3. Global env vars (WHATSAPP_ACCESS_TOKEN etc.). Backwards-
//      compatibility for any location that hasn't migrated yet —
//      the existing single-number setup keeps working unchanged
//      until the operator adds a row in the per-location settings.
//
// The webhook router (`resolveWhatsAppNumberByPhoneNumberId`)
// goes the other direction — given the phone_number_id Meta sent
// in the inbound payload, find the location that owns it.

import { createServerClient } from './supabase'

const META_API_VERSION = 'v21.0'
export const META_API_URL = `https://graph.facebook.com/${META_API_VERSION}`

/**
 * Build the env-fallback config object. Throws if env vars aren't
 * set — callers can decide whether to surface or fall through.
 */
function envConfig() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID
  const appId = process.env.WHATSAPP_APP_ID

  if (!token || !phoneNumberId) {
    return null
  }
  return {
    source: 'env',
    token,
    phoneNumberId,
    businessAccountId: businessAccountId || null,
    appId: appId || null,
    label: 'Global env-var config',
  }
}

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
    // gate reads this; env-fallback configs carry no rating (no gate).
    qualityRating: row.quality_rating ?? null,
    // WA-BUDGET — Meta messaging-limit tier as of the last webhook/poll
    // (TIER_250 … UNLIMITED, null = never fetched). The blast/drip tier-budget
    // gates read this; env-fallback configs carry no tier (no gate).
    messagingLimitTier: row.messaging_limit_tier ?? null,
  }
}

/**
 * Resolve the WhatsApp config to use for outbound sends from
 * `locationId`. Walks the three tiers above and returns the first
 * hit, or throws with a clear message naming what's missing.
 *
 * @param {string | null | undefined} locationId  When null/undefined,
 *   skips DB tiers and goes straight to env (matches the historical
 *   pre-WA-MULTI behaviour).
 * @returns {Promise<object>}  Config object with .token + .phoneNumberId
 *   at minimum.
 */
export async function getWhatsAppConfig(locationId) {
  // Tier 1: explicit DB row for this location, default-flagged.
  if (locationId) {
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
    if (rows && rows.length > 0) {
      return rowToConfig(rows[0])
    }
  }

  // Tier 3: env fallback.
  const env = envConfig()
  if (env) return env

  // No config anywhere — caller gets a precise error message.
  throw new Error(
    `WhatsApp not configured for location ${locationId || '(no-location-context)'}. ` +
    'Add a number under Settings → Locations → Integrations → WhatsApp, ' +
    'or set the global WHATSAPP_* env vars in Vercel.'
  )
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
 * unknown (the global env config is checked too — if a webhook
 * arrives for the env-config number we return a synthetic
 * location-less config). Throws when the lookup itself fails
 * (transient DB error) and the id doesn't match the env config —
 * callers must treat a throw as "owner undetermined", never as
 * "unknown number", so the two cases stay separately loggable.
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
    // WA-TECHPROV.4b — a transient lookup error must NEVER be
    // reported as "unknown number" (null): the webhook drops
    // unknowns, and a dropped message is permanently lost (we 200
    // + dedup, so Meta never retries). If the id matches the env
    // config we can still answer authoritatively; otherwise throw
    // so the webhook logs a resolver failure, not an unknown number.
    console.warn('[wa-config] phone_number_id lookup failed:', error.message)
    const env = envConfig()
    if (env && env.phoneNumberId === phoneNumberId) return env  // authoritative: the id is ours (env)
    throw new Error(`whatsapp_numbers lookup failed: ${error.message}`)  // webhook catch → drop + log
  }
  if (row) return rowToConfig(row)

  // Check env-var config — if the inbound matches the env-configured
  // number, the webhook is still "ours" and should be processed.
  const env = envConfig()
  if (env && env.phoneNumberId === phoneNumberId) return env

  return null
}

/**
 * WA-TECHPROV.4 / SAAS-2 — inbound routing decision for the webhook.
 *
 * Only an active whatsapp_numbers row may own inbound traffic. Anything
 * else — an unknown phone_number_id, or an env-var config (which carries
 * no location) — is dropped by the webhook. The historical first-location
 * fallback routed a foreign number's messages (and the contact + Mia
 * reply they spawned) into an arbitrary tenant.
 */
export function classifyInboundOwner(owningNumber) {
  if (owningNumber?.source === 'db' && owningNumber.locationId) {
    return { action: 'location', locationId: owningNumber.locationId }
  }
  return { action: 'drop' }
}
