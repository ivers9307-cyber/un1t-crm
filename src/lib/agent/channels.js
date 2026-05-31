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

export const META_GRAPH_VERSION = 'v21.0'
export const META_GRAPH_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`

export const SUPPORTED_PLATFORMS = Object.freeze(['instagram', 'messenger'])

// Fields that are secrets — masked on read, only overwritten on write
// when a fresh (non-masked, non-empty) value is supplied.
export const SECRET_FIELDS = Object.freeze(['access_token', 'app_secret'])

/**
 * Mask a secret for display: keep the last `keep` chars behind dots.
 * Returns null for empty input. Pure.
 */
export function maskSecret(value, keep = 6) {
  if (!value) return null
  const s = String(value)
  if (s.length <= keep) return '••••••'
  return `••••••${s.slice(-keep)}`
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
 */
export function maskConnectionRow(row) {
  if (!row) return row
  const out = { ...row }
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
  const fields = opts.fields || ['platform', 'label', 'external_account_id', 'page_id', 'app_id', 'display_name', 'is_active']
  const patch = {}
  for (const k of fields) {
    if (body[k] !== undefined) patch[k] = body[k]
  }
  for (const f of SECRET_FIELDS) {
    if (isFreshSecret(body[f])) patch[f] = String(body[f]).trim()
  }
  return patch
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
 */
export async function resolveLocationByExternalAccount(platform, externalAccountId, db = null) {
  if (!platform || !externalAccountId) return null
  const client = db || createServerClient()
  const { data } = await client.from('channel_connections')
    .select('*')
    .eq('platform', platform)
    .eq('external_account_id', externalAccountId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()
  if (!data) return null
  return { locationId: data.location_id, connection: data }
}
