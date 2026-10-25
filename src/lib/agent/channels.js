// RADAR-AGENT.0b — channel connection helpers for the customer agent.
//
// WhatsApp creds resolve via whatsapp-config.js (mig 176). This module
// is the equivalent for the OTHER Meta channels stored in
// channel_connections (mig 230) — Instagram now, Messenger later.
//
// Pure helpers (masking, shaping) are unit-tested; resolveChannelConnection
// does the single DB read. The customer agent core stays channel-agnostic:
// it asks "give me the active connection for this location + platform" and
// gets back a normalised object (or null), the same shape regardless of
// platform.

import { createServerClient } from '@/lib/supabase'
import { SECRET_MASK, maskSecretKeysDeep } from '@/lib/secret-keys'

export const META_GRAPH_VERSION = 'v21.0'
export const META_GRAPH_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`

// Instagram API with Instagram Login (IG-LOGIN) lives on its own Graph
// host with Instagram User tokens — NOT graph.facebook.com page tokens.
// All instagram-platform calls (DM send, profile fetch, feed sync) use
// this. META_GRAPH_URL stays for future Messenger (page-token) channels.
export const IG_GRAPH_VERSION = 'v25.0'
export const IG_GRAPH_URL = `https://graph.instagram.com/${IG_GRAPH_VERSION}`

export const SUPPORTED_PLATFORMS = Object.freeze(['instagram', 'messenger'])

// Fields that are secrets — masked on read, only overwritten on write
// when a fresh (non-masked, non-empty) value is supplied.
export const SECRET_FIELDS = Object.freeze(['access_token', 'app_secret'])

/**
 * Mask a secret for display: presence only. Returns null for empty input and
 * the fixed mask otherwise. Pure.
 *
 * SECFIX.3a (review S1) — it used to keep the last 6 characters as a hint.
 * No character of a stored credential leaves the server now; the card shows
 * "Connected" (has_access_token) and a password field of dots.
 */
export function maskSecret(value) {
  if (!value) return null
  return SECRET_MASK
}

/** Is a submitted secret a real new value (vs blank or the masked echo)? */
export function isFreshSecret(value) {
  if (value == null) return false
  const s = String(value).trim()
  if (!s) return false
  if (s.startsWith('••')) return false
  return true
}

/**
 * Shape a DB row for the browser: mask every secret field and add a
 * has_<field> boolean so the UI can show "set / not set". Pure.
 *
 * SECFIX.3a (review S1) — the two columns were not the only secrets on a
 * row: the registry (connection-registry.js) keeps whatever a provider's
 * legacy slice holds beyond its mapped columns in `config`, which for Glofox
 * is the api_token. So every secret-named key at any depth (mig 647's rule,
 * src/lib/secret-keys.js) is masked first, then the columns get their
 * null-when-empty mask and has_ flags (added last: `has_access_token` itself
 * ends in "token" and would otherwise be masked).
 */
export function maskConnectionRow(row) {
  if (!row) return row
  const out = { ...maskSecretKeysDeep(row) }
  for (const f of SECRET_FIELDS) {
    out[`has_${f}`] = !!row[f]
    out[f] = maskSecret(row[f])
  }
  return out
}

/**
 * Build the DB patch for a create/update from a submitted body.
 * - Non-secret fields: copied through when present.
 * - Secret fields: only included when a fresh value was supplied, so an
 *   un-edited masked field never overwrites the stored secret. Pure.
 *
 * @param {object} body
 * @param {object} [opts] { fields } allowed non-secret fields
 */
export function buildConnectionPatch(body, opts = {}) {
  const fields = opts.fields || ['platform', 'label', 'external_account_id', 'page_id', 'app_id', 'display_name', 'is_active', 'agent_enabled']
  const patch = {}
  for (const k of fields) {
    if (body[k] !== undefined) patch[k] = body[k]
  }
  for (const f of SECRET_FIELDS) {
    if (isFreshSecret(body[f])) patch[f] = String(body[f]).trim()
  }
  // A freshly pasted access token is a NEW token — the stored lifecycle
  // stamps (mig 408) describe the old one. Null them so nothing reads a
  // stale expiry as current; the weekly refresh cron repopulates them.
  // Same for the hub health stamps: an auth error flagged by the IG crons
  // or the DM send path described the old token, and no sweep clears a
  // non-expiry last_error, so without this a reconnect stayed red forever.
  if (patch.access_token) {
    patch.token_expires_at = null
    patch.token_refreshed_at = null
    patch.status = 'connected'
    patch.last_error = null
  }
  return patch
}

/**
 * Should the customer agent auto-reply on this connection's channel?
 * Default CLOSED: a missing row or unset flag means staff-only — the
 * agent only runs when an operator has explicitly opted the channel in
 * (mig 407). Staff inbox flows are unaffected either way. Pure.
 */
export function isAgentEnabledForConnection(connection) {
  return !!connection?.agent_enabled
}

/**
 * Shape the channel_connections patch for a successful Instagram Login
 * token refresh ({access_token, expires_in seconds} from
 * refresh_access_token). Returns null unless the response actually
 * contains a token — a failed refresh must never clobber the stored
 * (still-valid) token; the ~60-day runway absorbs missed weeks. Pure.
 */
export function buildTokenRefreshPatch(refreshJson, now = new Date()) {
  const token = refreshJson?.access_token
  if (!token || typeof token !== 'string') return null
  const expiresIn = Number(refreshJson.expires_in)
  return {
    access_token: token,
    token_refreshed_at: now.toISOString(),
    token_expires_at: Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(now.getTime() + expiresIn * 1000).toISOString()
      : null,
  }
}

/**
 * Resolve the active connection for a location + platform. Returns the
 * raw row (secrets intact — server-side use only) or null.
 *
 * @param {string} locationId
 * @param {string} platform   one of SUPPORTED_PLATFORMS
 * @param {object} [db]       optional injected client (tests)
 */
export async function resolveChannelConnection(locationId, platform, db = null) {
  if (!locationId || !platform) return null
  const client = db || createServerClient()
  const { data } = await client.from('channel_connections')
    .select('*')
    .eq('location_id', locationId)
    .eq('platform', platform)
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data || null
}

/**
 * Reverse lookup for inbound webhooks: which location owns this Meta
 * account id on this platform? Returns { locationId, connection } | null.
 * THROWS on a query error (W0.14) — null means "no active row", never
 * "the read failed".
 */
export async function resolveLocationByExternalAccount(platform, externalAccountId, db = null) {
  if (!platform || !externalAccountId) return null
  const client = db || createServerClient()
  const { data, error } = await client.from('channel_connections')
    .select('*')
    .eq('platform', platform)
    .eq('external_account_id', externalAccountId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()
  // W0.14 — a failed read is NOT "unmatched": the caller has already claimed
  // the dedup row, so swallowing this made Meta's retry a no-op and lost the
  // message for good. Throw so the webhook answers non-2xx and Meta retries.
  if (error) throw new Error(`channel_connections lookup failed: ${error.message}`)
  if (!data) return null
  return { locationId: data.location_id, connection: data }
}
