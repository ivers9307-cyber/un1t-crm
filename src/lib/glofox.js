// Glofox integration helpers (GLOFOX1).
//
// Pure functions — no DB / no fetch — so the receiver route can be
// thin and the tests can be tight. The receiver imports:
//   verifyGlofoxSignature() — HMAC-SHA256 against the operator's
//                             Glofox webhook secret. Constant-time.
//   parseGlofoxEvent()      — pull event_id / event_type / entity_id
//                             / contact_email out of an unfamiliar
//                             payload shape. Defensive — returns
//                             nulls rather than throwing on missing
//                             fields so dark-launch can still record
//                             the event for shape inspection.
//   tagsForGlofoxEvent()    — map a Glofox event_type string to the
//                             list of CRM tags to apply. Single
//                             source of truth — extending the
//                             integration with a new event type is
//                             a one-line change here.

import { createHmac, timingSafeEqual } from 'node:crypto'

// ─────────────────────────────────────────────────────────────
// Signature verification (HMAC-SHA256 hex)
// ─────────────────────────────────────────────────────────────
//
// Per Glofox docs:
//   Signature = Hex( HMAC-SHA256( YourSecretKey, StringToSign ) )
//
// The "StringToSign" is the raw request body (consistent with the
// Twilio/Stripe convention). The signature value arrives in a
// header — Glofox uses 'signature' (lowercase) in their docs.
// We treat it case-insensitively.

export function verifyGlofoxSignature({ rawBody, signatureHeader, secret }) {
  if (!rawBody || !signatureHeader || !secret) return false
  if (typeof rawBody !== 'string' || typeof signatureHeader !== 'string') return false

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  // Constant-time compare. Length mismatch returns false immediately
  // (timingSafeEqual would throw if buffers differ in length).
  if (expected.length !== signatureHeader.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────
// Payload parsing
// ─────────────────────────────────────────────────────────────
//
// We don't have official payload samples yet — the operator just
// requested webhook setup, real shapes will land during dark-launch.
// This parser is defensive: it tries the most likely paths for each
// field and returns null when nothing matches. Once we see real
// payloads we tighten the parser without changing the call sites.

const EVENT_ID_PATHS = [
  ['event_id'],
  ['eventId'],
  ['id'],
  ['_id'],
  ['message_id'],
  ['data', 'event_id'],
  ['data', 'id'],
]
const EVENT_TYPE_PATHS = [
  ['event_type'],
  ['eventType'],
  ['type'],
  ['event'],
  ['data', 'event_type'],
]
const BRANCH_ID_PATHS = [
  ['branch_id'],
  ['branchId'],
  ['data', 'branch_id'],
  ['data', 'branchId'],
]
const ENTITY_ID_PATHS = [
  ['data', 'id'],
  ['data', '_id'],
  ['data', 'booking_id'],
  ['data', 'member_id'],
  ['data', 'membership_id'],
  ['entity_id'],
]
// Email lives under different keys depending on the entity:
//   - member.created     → data.email
//   - booking.created    → data.member.email OR data.member_email
//   - membership.cancelled → data.member.email
const CONTACT_EMAIL_PATHS = [
  ['data', 'email'],
  ['data', 'member_email'],
  ['data', 'member', 'email'],
  ['data', 'user', 'email'],
  ['data', 'customer', 'email'],
  ['email'],
]

function pluck(obj, paths) {
  for (const path of paths) {
    let cur = obj
    let ok = true
    for (const key of path) {
      if (cur == null || typeof cur !== 'object') { ok = false; break }
      cur = cur[key]
    }
    if (ok && cur != null && cur !== '') return cur
  }
  return null
}

export function parseGlofoxEvent(payload) {
  if (!payload || typeof payload !== 'object') {
    return { eventId: null, eventType: null, branchId: null, entityId: null, contactEmail: null }
  }
  const eventId = pluck(payload, EVENT_ID_PATHS)
  const eventType = pluck(payload, EVENT_TYPE_PATHS)
  const branchId = pluck(payload, BRANCH_ID_PATHS)
  const entityId = pluck(payload, ENTITY_ID_PATHS)
  const emailRaw = pluck(payload, CONTACT_EMAIL_PATHS)
  const contactEmail = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : null
  return {
    eventId: eventId != null ? String(eventId) : null,
    eventType: eventType != null ? String(eventType) : null,
    branchId: branchId != null ? String(branchId) : null,
    entityId: entityId != null ? String(entityId) : null,
    contactEmail,
  }
}

// ─────────────────────────────────────────────────────────────
// Event-type → CRM tag map
// ─────────────────────────────────────────────────────────────
//
// Single source of truth for "when Glofox says X, apply tag Y to
// the matching CRM contact." Each tag becomes the trigger for any
// sequence the operator has built with trigger_type='tag_added'
// + trigger_config.tag === '<tag>'.
//
// Tag naming convention: glofox_<entity>_<verb>. Snake_case. Matches
// the codebase's existing contact_tags conventions.
//
// Real Glofox event_type strings will be confirmed during dark-
// launch. The keys below are the most likely Glofox conventions
// (entity.verb, dot-separated lowercase) plus common variations
// (snake_case, hyphenated). Add more keys per actual payload —
// updating this single object surfaces the new event type to every
// downstream sequence template + the audit UI.

const EVENT_TYPE_TAGS = {
  // Bookings
  'booking.created':         ['glofox_booking_created'],
  'booking.cancelled':       ['glofox_booking_cancelled'],
  'booking.canceled':        ['glofox_booking_cancelled'], // US spelling
  'booking.no_show':         ['glofox_booking_no_show'],
  'booking.attended':        ['glofox_booking_attended'],
  'booking.late_cancel':     ['glofox_booking_late_cancel'],
  // Memberships
  'membership.created':      ['glofox_membership_created'],
  'membership.cancelled':    ['glofox_membership_cancelled'],
  'membership.canceled':     ['glofox_membership_cancelled'],
  'membership.ended':        ['glofox_membership_ended'],
  'membership.expired':      ['glofox_membership_ended'],
  'membership.paused':       ['glofox_membership_paused'],
  'membership.unpaused':     ['glofox_membership_unpaused'],
  'membership.renewed':      ['glofox_membership_renewed'],
  // Members (+ leads)
  'member.created':          ['glofox_member_created'],
  'member.updated':          ['glofox_member_updated'],
  'lead.created':            ['glofox_lead_created'],
  // Access (barcodes — not door access)
  'access.created':          ['glofox_access_created'],
  'access.updated':          ['glofox_access_updated'],
}

export function tagsForGlofoxEvent(eventType) {
  if (!eventType) return []
  const direct = EVENT_TYPE_TAGS[eventType]
  if (direct) return direct.slice()
  // Forgiving lookups — try common variations before giving up.
  const lower = eventType.toLowerCase()
  if (EVENT_TYPE_TAGS[lower]) return EVENT_TYPE_TAGS[lower].slice()
  // snake_case → dotted
  const dotted = lower.replace(/_/g, '.')
  if (EVENT_TYPE_TAGS[dotted]) return EVENT_TYPE_TAGS[dotted].slice()
  // hyphenated → dotted
  const fromHyphen = lower.replace(/-/g, '.')
  if (EVENT_TYPE_TAGS[fromHyphen]) return EVENT_TYPE_TAGS[fromHyphen].slice()
  return []
}

// Surface the registry for tests + future admin UI.
export { EVENT_TYPE_TAGS }

// ─────────────────────────────────────────────────────────────
// Per-location credentials (GLOFOX1.6)
// ─────────────────────────────────────────────────────────────
//
// All Glofox config lives on locations.settings.glofox:
//   { branch_id, api_key, api_token, webhook_secret }
// — set via the LocationForm "Glofox Integration" panel. Helpers
// here read from the DB, so multi-location works out of the box
// (when Hatch Street goes live on Glofox, each location's row
// carries its own four values; nothing in env to update).
//
// Earlier (GLOFOX1) we used env vars. They're gone now — see the
// .env.local.example diff in the GLOFOX1.6 commit for the cleanup.
//
// Base URL is the production Glofox host. Sandbox endpoints would
// need a parallel constant + a way to switch between them; we'll
// add that when/if Glofox confirms sandbox credentials are
// separate (see request-access doc — they say both sets point at
// the same env config which is unusual).

const GLOFOX_API_BASE = 'https://gf-api.aws.glofox.com/prod'

/**
 * Pull Glofox credentials for a single location.
 * @param {object} db        Service-role Supabase client
 * @param {string} locationId  CRM location uuid
 * @returns {Promise<{branchId, apiKey, apiToken, webhookSecret}>}
 *   All fields are null when missing. Use missingGlofoxCredentialsForLocation()
 *   for a friendly array of missing-field names.
 */
export async function glofoxCredentialsForLocation(db, locationId) {
  if (!db || !locationId) {
    return { branchId: null, apiKey: null, apiToken: null, webhookSecret: null }
  }
  const { data } = await db
    .from('locations')
    .select('settings')
    .eq('id', locationId)
    .maybeSingle()
  const cfg = data?.settings?.glofox || {}
  return {
    branchId:      cfg.branch_id      || null,
    apiKey:        cfg.api_key        || null,
    apiToken:      cfg.api_token      || null,
    webhookSecret: cfg.webhook_secret || null,
  }
}

/**
 * Pull Glofox credentials by branch_id (used by the inbound
 * webhook receiver — it knows the branch from the payload before
 * it knows the location). Returns location_id alongside the
 * credentials so the caller can attribute the event correctly.
 *
 * @param {object} db
 * @param {string} branchId
 * @returns {Promise<null | {locationId, branchId, apiKey, apiToken, webhookSecret}>}
 */
export async function glofoxCredentialsByBranchId(db, branchId) {
  if (!db || !branchId) return null
  // settings is JSONB; the @> operator finds rows where the
  // settings tree contains the given subtree. Index on settings
  // (mig 004 GIN if present) keeps this fast even at scale.
  const { data } = await db
    .from('locations')
    .select('id, settings')
    .filter('settings', 'cs', JSON.stringify({ glofox: { branch_id: branchId } }))
    .limit(1)
  const row = data?.[0]
  if (!row) return null
  const cfg = row.settings?.glofox || {}
  return {
    locationId:    row.id,
    branchId:      cfg.branch_id      || null,
    apiKey:        cfg.api_key        || null,
    apiToken:      cfg.api_token      || null,
    webhookSecret: cfg.webhook_secret || null,
  }
}

/**
 * Returns array of friendly field names that are NOT set on a
 * location. Used by the ping endpoint for "tell the operator
 * exactly what to fill in."
 */
export function missingGlofoxCredentialsForLocation(creds) {
  const missing = []
  if (!creds?.branchId)      missing.push('Branch ID')
  if (!creds?.apiKey)        missing.push('API Key')
  if (!creds?.apiToken)      missing.push('API Token')
  // Webhook secret isn't required for outbound calls — only for
  // inbound webhook signature verification. Caller decides whether
  // to flag it as missing.
  return missing
}

/**
 * Outbound Glofox API call with the three required headers
 * sourced from a per-location credentials object.
 *
 * @param {{branchId, apiKey, apiToken}} creds  From glofoxCredentialsForLocation
 * @param {string} pathOrUrl  Path like '/2.0/members?limit=1' OR a full URL
 * @param {RequestInit} options  Standard fetch options (method, body, headers)
 * @returns {Promise<Response>}
 */
export async function glofoxFetch(creds, pathOrUrl, options = {}) {
  if (!creds || !creds.branchId || !creds.apiKey || !creds.apiToken) {
    throw new Error('Glofox API credentials missing (need branchId, apiKey, apiToken on the location)')
  }
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${GLOFOX_API_BASE}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`
  const headers = {
    'x-glofox-branch-id': creds.branchId,
    'x-api-key':          creds.apiKey,
    'x-glofox-api-token': creds.apiToken,
    ...(options.headers || {}),
  }
  return fetch(url, { ...options, headers })
}

// ─────────────────────────────────────────────────────────────
// Per-member API helpers (GLOFOX2.1.11 — Plan A credit detection)
// ─────────────────────────────────────────────────────────────

/**
 * Fetch the active + historical credit packs for a Glofox member.
 * Returns the data array (Credits[]) or [] on failure / no data.
 *
 * Used to drive credit_member detection — a paying customer with
 * an active class-pack credit pack qualifies as a Credit Member
 * (separate audience from subscription members). See
 * src/lib/glofox-sync.js:detectCreditMember.
 *
 * Best-effort: a network/API failure here returns [] so the
 * containing sync can still proceed (member contact gets synced,
 * credit_member detection is skipped, next sync gets it right).
 */
export async function fetchUserCredits(creds, userId) {
  if (!creds || !userId) return []
  try {
    const r = await glofoxFetch(creds, `/2.0/credits?user_id=${encodeURIComponent(userId)}`)
    if (!r.ok) return []
    const body = await r.json()
    return Array.isArray(body?.data) ? body.data : []
  } catch {
    return []
  }
}

/**
 * Fetch a Glofox Membership (the catalog entry, with plans[]) by
 * its id. Optional `cache` Map memoises within a sync run — many
 * members share the same Membership (e.g., everyone on Class Packs
 * shares membership 6512ae6b179d3834bb0b7f78), so the bulk cron
 * benefits from caching across the run.
 *
 * Returns the membership object or null on failure / not-found.
 * Cache stores nulls too so repeated lookups for a missing
 * membership don't re-hit the API.
 */
export async function fetchMembership(creds, membershipId, cache = null) {
  if (!creds || !membershipId) return null
  if (cache && cache.has(membershipId)) return cache.get(membershipId)
  let result = null
  try {
    const r = await glofoxFetch(creds, `/2.0/memberships/${encodeURIComponent(membershipId)}`)
    if (r.ok) {
      result = await r.json()
    }
  } catch {
    result = null
  }
  if (cache) cache.set(membershipId, result)
  return result
}
