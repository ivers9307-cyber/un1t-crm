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
import { getGlofoxConfig, findGlofoxConfigByBranchId } from '@/lib/connection-registry'

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
  // GLOFOX2.1.20 — newer event schemas (INVOICE_UPDATED,
  // MEMBER_UPDATED, MEMBERSHIP_UPDATED) wrap data under Payload.
  ['Payload', 'id'],
  ['Metadata', 'trace_id'],
  // GLOFOX-REACTIVE — SERVICE_* events (per openapi.yaml) use
  // lowercase metadata/payload. Their per-emission id is
  // metadata.trace_id. We deliberately do NOT fall back to
  // payload.id (the service id) as an event id: it's stable across
  // updates, so a pause→resume SERVICE_UPDATED would be dropped as a
  // "duplicate". If trace_id is absent the receiver inserts without
  // dedup, which is safe — the service upsert is idempotent.
  ['metadata', 'trace_id'],
]
const EVENT_TYPE_PATHS = [
  ['event_type'],
  ['eventType'],
  ['type'],
  ['Type'],
  ['event'],
  ['data', 'event_type'],
]
const BRANCH_ID_PATHS = [
  ['branch_id'],
  ['branchId'],
  ['data', 'branch_id'],
  ['data', 'branchId'],
  // INVOICE_UPDATED carries location_id under Metadata; use it as
  // a branch_id fallback (the receiver looks up the location by
  // branch_id first, but invoice events Glofox-side use the
  // location/branch interchangeably).
  ['Metadata', 'location_id'],
  ['Metadata', 'branch_id'],
  ['Payload', 'branch_id'],
  // GLOFOX-REACTIVE — SERVICE_* events carry the location under
  // lowercase metadata (same location/branch interchangeability as
  // invoice events).
  ['metadata', 'location_id'],
  ['metadata', 'branch_id'],
]
const ENTITY_ID_PATHS = [
  ['data', 'id'],
  ['data', '_id'],
  ['data', 'booking_id'],
  ['data', 'member_id'],
  ['data', 'membership_id'],
  ['entity_id'],
  ['Payload', 'id'],
  // GLOFOX-REACTIVE — SERVICE_* service id (lowercase payload).
  ['payload', 'id'],
]
// Email lives under different keys depending on the entity:
//   - member.created     → data.email
//   - booking.created    → data.member.email OR data.member_email
//   - membership.cancelled → data.member.email
//   - INVOICE_UPDATED    → Payload.user.email
//   - MEMBER_UPDATED     → Payload.email (per spec)
const CONTACT_EMAIL_PATHS = [
  ['data', 'email'],
  ['data', 'member_email'],
  ['data', 'member', 'email'],
  ['data', 'user', 'email'],
  ['data', 'customer', 'email'],
  ['email'],
  ['Payload', 'user', 'email'],
  ['Payload', 'email'],
  ['Payload', 'contact_email'],
]
// GLOFOX5.1 — Glofox member ID lookup paths. Many event payloads
// (BOOKING_*, MEMBERSHIP_*, COURSE_BOOKING_*) carry only user_id +
// no email — we use this as a fallback contact-lookup key against
// contacts.glofox_member_id. MEMBER_* events use Payload.id (the
// member's own ID) since user_id isn't present on a member payload.
const USER_ID_PATHS = [
  ['Payload', 'user_id'],
  ['Payload', 'user', 'id'],
  ['data', 'user_id'],
  ['data', 'member_id'],
  ['data', 'member', 'id'],
  ['data', 'user', 'id'],
  // MEMBER_* events: the member ID IS the entity ID.
  ['Payload', 'id'],
  ['data', 'id'],
  // GLOFOX-REACTIVE — SERVICE_* events link to the member via
  // payload.member_ids (an array). pluck() walks integer keys as
  // array indices, so [.., 0] resolves the first member id — which
  // matches contacts.glofox_member_id (the existing fallback lookup
  // in the receiver, no new lookup path needed). member_id_2 covers
  // a shared/family service's second member defensively.
  ['payload', 'member_ids', 0],
  ['Payload', 'member_ids', 0],
  ['payload', 'user_id'],
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
    return { eventId: null, eventType: null, branchId: null, entityId: null, contactEmail: null, userId: null }
  }
  const eventId = pluck(payload, EVENT_ID_PATHS)
  const eventType = pluck(payload, EVENT_TYPE_PATHS)
  const branchId = pluck(payload, BRANCH_ID_PATHS)
  const entityId = pluck(payload, ENTITY_ID_PATHS)
  const emailRaw = pluck(payload, CONTACT_EMAIL_PATHS)
  const contactEmail = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : null
  // GLOFOX5.1 — Glofox member ID for contact lookup when email isn't
  // in the payload (BOOKING_*, MEMBERSHIP_*).
  const userId = pluck(payload, USER_ID_PATHS)
  return {
    eventId: eventId != null ? String(eventId) : null,
    eventType: eventType != null ? String(eventType) : null,
    branchId: branchId != null ? String(branchId) : null,
    entityId: entityId != null ? String(entityId) : null,
    contactEmail,
    userId: userId != null ? String(userId) : null,
  }
}

// ─────────────────────────────────────────────────────────────
// Event-type → CRM tag map (GLOFOX2.1.12 — spec-aligned)
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
// GLOFOX2.1.12 — keys updated to UPPERCASE_SNAKE_CASE per the
// official Glofox openapi.yaml. The descriptions of the webhook
// endpoints (member, membership, booking, course_booking, invoice,
// access, event, eagreement, service) confirm these exact event
// type strings:
//
//   member:         MEMBER_CREATED, MEMBER_UPDATED
//   membership:     MEMBERSHIP_CREATED, MEMBERSHIP_UPDATED, MEMBERSHIP_DELETED
//   booking:        BOOKING_CREATED, BOOKING_DELETED, BOOKING_UPDATED
//   course_booking: COURSE_BOOKING_CREATED, COURSE_BOOKING_DELETED
//   invoice:        INVOICE_UPDATED
//   access:         MEMBER_ACCESS_INFO_CREATED, MEMBER_ACCESS_INFO_UPDATED
//   event:          EVENT_CREATED, EVENT_UPDATED, EVENT_DELETED
//   eagreement:     EAGREEMENT_CREATED, EAGREEMENT_UPDATED
//   service:        SERVICE_CREATED, SERVICE_UPDATED, SERVICE_DELETED
//
// tagsForGlofoxEvent() also accepts the dotted-lowercase variants
// (member.created, etc.) for backward compatibility — the
// normaliser maps both forms to the same canonical lookup.

const EVENT_TYPE_TAGS = {
  // Members
  'MEMBER_CREATED':              ['glofox_member_created'],
  'MEMBER_UPDATED':              ['glofox_member_updated'],
  // Memberships
  'MEMBERSHIP_CREATED':          ['glofox_membership_created'],
  'MEMBERSHIP_UPDATED':          ['glofox_membership_updated'],
  'MEMBERSHIP_DELETED':          ['glofox_membership_deleted'],
  // Bookings
  'BOOKING_CREATED':             ['glofox_booking_created'],
  'BOOKING_UPDATED':             ['glofox_booking_updated'],
  'BOOKING_DELETED':             ['glofox_booking_cancelled'],
  // Course bookings (multi-session courses)
  'COURSE_BOOKING_CREATED':      ['glofox_course_booking_created'],
  'COURSE_BOOKING_DELETED':      ['glofox_course_booking_cancelled'],
  // Invoices
  'INVOICE_UPDATED':             ['glofox_invoice_updated'],
  // Access (barcodes / door access info)
  'MEMBER_ACCESS_INFO_CREATED':  ['glofox_access_created'],
  'MEMBER_ACCESS_INFO_UPDATED':  ['glofox_access_updated'],
  // Events (class schedule changes — rarely contact-relevant)
  'EVENT_CREATED':               ['glofox_event_created'],
  'EVENT_UPDATED':               ['glofox_event_updated'],
  'EVENT_DELETED':               ['glofox_event_deleted'],
  // E-agreement signatures
  'EAGREEMENT_CREATED':          ['glofox_eagreement_created'],
  'EAGREEMENT_UPDATED':          ['glofox_eagreement_updated'],
  // Service catalog
  'SERVICE_CREATED':             ['glofox_service_created'],
  'SERVICE_UPDATED':             ['glofox_service_updated'],
  'SERVICE_DELETED':             ['glofox_service_deleted'],
}

// Backward compat: dotted-lowercase variants (which we shipped in
// EVENT_TYPE_TAGS pre-2.1.12 based on a guess about the Glofox
// convention) map to the same canonical UPPERCASE_SNAKE_CASE form.
// This keeps any existing test fixtures + manually-crafted webhook
// replays working.
const EVENT_TYPE_ALIASES = {
  'booking.created':       'BOOKING_CREATED',
  'booking.cancelled':     'BOOKING_DELETED',
  'booking.canceled':      'BOOKING_DELETED',
  'booking.no_show':       'BOOKING_UPDATED',
  'booking.attended':      'BOOKING_UPDATED',
  'booking.late_cancel':   'BOOKING_UPDATED',
  'membership.created':    'MEMBERSHIP_CREATED',
  'membership.cancelled':  'MEMBERSHIP_DELETED',
  'membership.canceled':   'MEMBERSHIP_DELETED',
  'membership.ended':      'MEMBERSHIP_DELETED',
  'membership.expired':    'MEMBERSHIP_DELETED',
  'membership.paused':     'MEMBERSHIP_UPDATED',
  'membership.unpaused':   'MEMBERSHIP_UPDATED',
  'membership.renewed':    'MEMBERSHIP_UPDATED',
  'member.created':        'MEMBER_CREATED',
  'member.updated':        'MEMBER_UPDATED',
  'lead.created':          'MEMBER_CREATED',
  'access.created':        'MEMBER_ACCESS_INFO_CREATED',
  'access.updated':        'MEMBER_ACCESS_INFO_UPDATED',
}

export function tagsForGlofoxEvent(eventType) {
  if (!eventType) return []
  // 1. Direct UPPERCASE_SNAKE_CASE hit (the canonical Glofox form
  //    per openapi.yaml).
  const direct = EVENT_TYPE_TAGS[eventType]
  if (direct) return direct.slice()
  // 2. Normalise to UPPERCASE_SNAKE_CASE and re-try. Handles
  //    lowercase, hyphens, dots, mixed case from older fixtures.
  const upper = String(eventType).toUpperCase().replace(/[.\-]/g, '_')
  if (EVENT_TYPE_TAGS[upper]) return EVENT_TYPE_TAGS[upper].slice()
  // 3. Dotted-lowercase aliases for backward compat.
  const lower = String(eventType).toLowerCase()
  const aliasTarget = EVENT_TYPE_ALIASES[lower]
  if (aliasTarget && EVENT_TYPE_TAGS[aliasTarget]) {
    return EVENT_TYPE_TAGS[aliasTarget].slice()
  }
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
    return { branchId: null, apiKey: null, apiToken: null, namespace: null, webhookSecret: null }
  }
  // INTEG-A2 dual-read: active channel_connections row first, legacy
  // locations.settings.glofox otherwise (same shape either way).
  const cfg = await getGlofoxConfig(db, locationId)
  return {
    branchId:      cfg.branch_id      || null,
    apiKey:        cfg.api_key        || null,
    apiToken:      cfg.api_token      || null,
    // PIPELINE5.5e: namespace is required by /Analytics/report and
    // a few v3 endpoints. We had been silently dropping it from
    // every call (Glofox returns 200-but-empty when it's absent on
    // the analytics endpoint). Source of truth: the studio's
    // namespace as it appears in webhook payload.Payload.namespace
    // (e.g. "untstillorgan"). Surface it via settings.glofox.namespace
    // — one row UPDATE per location to backfill.
    namespace:     cfg.namespace      || null,
    // STUDIO-KPI.4: operator-editable trainer-id → display-name map
    // (settings.glofox.trainer_names, via the Glofox settings tab).
    // Overrides API-resolved names in resolveTrainerNames.
    trainerNames:  (cfg.trainer_names && typeof cfg.trainer_names === 'object')
      ? cfg.trainer_names
      : null,
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
  // INTEG-A2 dual-read: the registry indexes (platform,
  // external_account_id), so an active glofox row resolves directly.
  const fromRegistry = await findGlofoxConfigByBranchId(db, branchId)
  if (fromRegistry) {
    const cfg = fromRegistry.cfg
    return {
      locationId:    fromRegistry.locationId,
      branchId:      cfg.branch_id      || null,
      apiKey:        cfg.api_key        || null,
      apiToken:      cfg.api_token      || null,
      webhookSecret: cfg.webhook_secret || null,
    }
  }
  // Legacy fallback. settings is JSONB; the @> operator finds rows
  // where the settings tree contains the given subtree. Index on
  // settings (mig 004 GIN if present) keeps this fast even at scale.
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
// GLOFOX-BACKOFF (2026-05-30) — transient-failure retry. The
// glofox-detail-backfill cron fans out thousands of /members/:id
// calls 5-at-a-time; without a retry on 429 (rate-limit) / 5xx
// (upstream blip) those land as fetch_failed and only get retried a
// whole tick later, slowing coverage. A bounded in-place retry that
// honours Retry-After lets the call succeed within the same tick.
const GLOFOX_MAX_RETRIES = 3

/**
 * Backoff delay (ms) for a transient Glofox response. Honours a
 * numeric Retry-After (seconds, capped 30s) when present, else
 * exponential 500ms·2^attempt capped at 8s plus jitter. Pure —
 * exported for unit testing.
 */
export function computeGlofoxBackoffMs(attempt, retryAfterSeconds = null) {
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(30_000, retryAfterSeconds * 1000)
  }
  const base = Math.min(8000, 500 * 2 ** attempt)
  return base + Math.floor(Math.random() * 250)
}

const _glofoxSleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  let res
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { ...options, headers })
    // Retry only transient statuses, and only while we have budget.
    if ((res.status === 429 || res.status >= 500) && attempt < GLOFOX_MAX_RETRIES) {
      const retryAfter = Number(res.headers?.get?.('retry-after'))
      await _glofoxSleep(computeGlofoxBackoffMs(attempt, Number.isFinite(retryAfter) ? retryAfter : null))
      continue
    }
    break
  }
  return res
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
  const { credits } = await fetchUserCreditsResult(creds, userId)
  return credits
}

// MIA-CREDITS.1 — ok-aware variant (the fetchUserBookingsResult pattern):
// fetchUserCredits collapses "the read failed" and "genuinely no credit
// records" into the same [], which is fine for callers that fail toward
// staff review, but a caller that ESCALATES on empty (Mia's booking
// pre-flight) must not escalate every booking during a Glofox blip.
export async function fetchUserCreditsResult(creds, userId) {
  if (!creds || !userId) return { ok: false, credits: [] }
  try {
    const r = await glofoxFetch(creds, `/2.0/credits?user_id=${encodeURIComponent(userId)}`)
    if (!r.ok) return { ok: false, credits: [] }
    const body = await r.json()
    return { ok: true, credits: Array.isArray(body?.data) ? body.data : [] }
  } catch {
    return { ok: false, credits: [] }
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

/**
 * Fetch a paginated list of leads from a branch via
 * POST /2.1/branches/{branchId}/leads/filter.
 *
 * IMPORTANT (GLOFOX2.4): this endpoint scopes to the LEADS funnel
 * view only — it returns 0 for converted MEMBERs even when
 * lead_status='MEMBER' is in the filter. Confirmed against live
 * Stillorgan data (8129 total members, /leads/filter with MEMBER
 * filter returned 0). For "every user at the studio" use
 * fetchAllMembersPage instead.
 *
 * Kept around for funnel-specific lookups (e.g., "all leads
 * created in the last hour" — useful for Sales pipeline UIs that
 * truly only want leads). Not used by bulk-sync or the cron any
 * more.
 *
 * Per the spec, UserFilters supports:
 *   lead_status: array of LEAD/TRIAL/COLD/MEMBER/NO_SALE_TRIAL/TOUR/NO_SALE_TOUR
 *   source:      array of MEMBER_APP/CLASSPASS/DASHBOARD/etc.
 *   created:     { start, end } — Unix seconds
 *   modified:    { start, end } — Unix seconds
 *   name:        string — searches name/first_name/last_name/email/phone
 *   deleted:     boolean — default false (active users only)
 *
 * Returns { data, total } shape from the response, OR { data: [],
 * total: 0 } on failure. Best-effort.
 */
export async function fetchBranchLeads(creds, filters = {}, pagination = { skip: 0, limit: 50 }) {
  if (!creds || !creds.branchId) return { data: [], total: 0 }
  try {
    const r = await glofoxFetch(
      creds,
      `/2.1/branches/${encodeURIComponent(creds.branchId)}/leads/filter`,
      {
        method: 'POST',
        body: JSON.stringify({ filters, pagination }),
      },
    )
    if (!r.ok) return { data: [], total: 0 }
    const body = await r.json()
    return {
      data: Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []),
      total: typeof body?.total_count === 'number' ? body.total_count
           : typeof body?.total === 'number' ? body.total
           : null,
      raw: body,
    }
  } catch {
    return { data: [], total: 0 }
  }
}

/**
 * Fetch a paginated page of ALL members at the branch via
 * GET /2.0/members?page=N&limit=M. This is the canonical "every
 * user at the studio" endpoint per Glofox.
 *
 * Empirically confirmed (GLOFOX2.4):
 *   - Returns every user regardless of lead_status (TRIAL / LEAD /
 *     MEMBER / NO_SALE_* etc all in the same response).
 *   - Sorted by `modified` DESC (most recently modified first).
 *     Critical for the daily cron — early-terminate as soon as
 *     we see a member with modified < cutoff to skip the rest.
 *   - Response shape: { object, page, limit, has_more, total_count, data: [...] }
 *   - Uses page+limit (NOT skip+limit). Convert from skip via
 *     page = Math.floor(skip / limit) + 1.
 *
 * Returns { data, total, hasMore } or { data: [], total: 0,
 * hasMore: false } on failure. Best-effort.
 */
export async function fetchAllMembersPage(creds, { page = 1, limit = 50 } = {}) {
  if (!creds || !creds.branchId) return { data: [], total: 0, hasMore: false }
  const safePage = Math.max(1, Math.floor(page))
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100)
  try {
    const r = await glofoxFetch(creds, `/2.0/members?page=${safePage}&limit=${safeLimit}`)
    if (!r.ok) return { data: [], total: 0, hasMore: false }
    const body = await r.json()
    return {
      data: Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []),
      total: typeof body?.total_count === 'number' ? body.total_count
           : typeof body?.total === 'number' ? body.total
           : null,
      hasMore: body?.has_more === true,
    }
  } catch {
    return { data: [], total: 0, hasMore: false }
  }
}

/**
 * Fetch the studio payments report via POST /Analytics/report.
 *
 * Per the spec, the body shape is PaymentsReportRequest:
 *   { branch_id, namespace, start, end, model: 'TransactionsList',
 *     filter: { ReportByMembers: bool, CompareToRanges: bool,
 *               PaymentMethods: [{id}] } }
 *
 * Returns { ok, status, body }. The body shape is
 * PaymentsReportResponse — { TransactionsList: { details: [Transaction] } }
 * by default. The ReportByMembers=true variant isn't documented;
 * surface the raw body so the caller can inspect.
 *
 * PIPELINE5.5d: the OpenAPI example for /Analytics/report always
 * populates filter.PaymentMethods with every documented method
 * type. Earlier callers that omitted it (GLOFOX2.1.19, PIPELINE5.5)
 * received HTTP 200 with TransactionsList.details: []. Strong
 * hypothesis is that filter.PaymentMethods behaves as "match ANY of
 * these methods" and an absent array filters every transaction out.
 * We now default to the full list so omitting it from a call site
 * doesn't silently suppress everything.
 */
const DEFAULT_PAYMENT_METHODS = [
  { id: 'cash' },
  { id: 'credit_card' },
  { id: 'bank_transfer' },
  { id: 'paypal' },
  { id: 'direct_debit' },
  { id: 'complimentary' },
  { id: 'wallet' },
]

export async function fetchPaymentsReport(creds, opts = {}) {
  if (!creds || !creds.branchId) {
    return { ok: false, status: 400, body: { error: 'missing branch credentials' } }
  }
  const startSec = Number.isFinite(opts.start)
    ? opts.start
    : Math.floor((Date.now() - 30 * 86400 * 1000) / 1000)
  const endSec = Number.isFinite(opts.end)
    ? opts.end
    : Math.floor(Date.now() / 1000)
  // Default to the full payment-methods list (see comment on
  // DEFAULT_PAYMENT_METHODS). Caller can pass `paymentMethods: []`
  // to test the unfiltered behaviour explicitly, or pass a subset
  // for narrower reports.
  const paymentMethods = Array.isArray(opts.paymentMethods)
    ? opts.paymentMethods
    : DEFAULT_PAYMENT_METHODS
  // namespace: prefer caller-supplied; fall back to creds.namespace
  // (read from settings.glofox.namespace by glofoxCredentialsForLocation).
  // Glofox returns 200-but-empty when this is missing, so make sure
  // SOMETHING is set rather than silently dropping it from the body.
  const body = {
    branch_id: creds.branchId,
    namespace: opts.namespace || creds.namespace || null,
    start: String(startSec),
    end: String(endSec),
    model: opts.model || 'TransactionsList',
    filter: {
      ReportByMembers: opts.byMembers === true,
      CompareToRanges: false,
      PaymentMethods: paymentMethods,
    },
  }
  try {
    const r = await glofoxFetch(creds, '/Analytics/report', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    let parsed
    try { parsed = await r.json() } catch { parsed = null }
    return { ok: r.ok, status: r.status, body: parsed, request_body: body }
  } catch (e) {
    return { ok: false, status: 0, body: { error: e?.message || 'network error' } }
  }
}

// ─────────────────────────────────────────────────────────────
// CRM → Glofox push helpers (GLOFOX3.1 — bidirectional sync)
// ─────────────────────────────────────────────────────────────
//
// Three operations needed for the bidirectional model the
// operator chose (per-flow opt-in, not blanket every-contact):
//
//   1. Search by email — dup detection on every CRM contact
//      create (link existing Glofox member rather than duplicate)
//   2. Register a new Glofox member — when an opt-in flow
//      (booking form, event with checkbox, manual button) wants
//      a fresh Glofox account
//   3. Purchase a membership — pair with register() so new
//      accounts land with the studio's trial product attached
//
// Plus a helper for the LocationForm picker to list available
// memberships at the studio (operator chooses which one to use
// as the trial).

/**
 * Search Glofox for a member by email.
 * Uses the v3 namespace search per the spec; falls back to a
 * /2.0/members scan if the v3 endpoint isn't available (defensive
 * for older firmwares).
 *
 * Returns { found, member, error }. found=true with a member
 * object means we should LINK rather than create.
 */
export async function searchGlofoxByEmail(creds, email) {
  if (!creds?.branchId || typeof email !== 'string' || !email.trim()) {
    return { found: false, member: null, error: 'missing args' }
  }
  const lc = email.trim().toLowerCase()
  try {
    // v3 namespace search — POST body { email } per the spec.
    const r = await glofoxFetch(creds, '/v3.0/namespaces/members/retrieve', {
      method: 'POST',
      body: JSON.stringify({ email: lc }),
    })
    if (r.ok) {
      const body = await r.json()
      // Response shape varies — try the common shapes.
      const candidates = Array.isArray(body?.data) ? body.data
                       : Array.isArray(body?.members) ? body.members
                       : Array.isArray(body) ? body
                       : (body && typeof body === 'object' && body._id ? [body] : [])
      // Filter to exact email match (case-insensitive). The search
      // is theoretically exact but defending against fuzzy matches.
      const exact = candidates.filter(c =>
        typeof c?.email === 'string' && c.email.toLowerCase() === lc
      )
      if (exact.length === 1) return { found: true, member: exact[0], error: null }
      if (exact.length > 1) {
        // Multiple Glofox accounts for one email — operator review.
        return { found: true, member: exact[0], error: 'multiple_glofox_matches', allMatches: exact }
      }
    }
    return { found: false, member: null, error: r.ok ? null : `Glofox HTTP ${r.status}` }
  } catch (e) {
    return { found: false, member: null, error: e?.message || 'search failed' }
  }
}

/**
 * Register a new Glofox member via POST /2.0/register.
 *
 * Required body fields per the spec: first_name, last_name, email,
 * type='MEMBER', lead_status, password. Optional: phone, birth,
 * emergency_contact, consent.
 *
 * Returns { ok, member, error }. member._id is the new
 * glofox_member_id we write to the CRM contact row.
 *
 * Best-effort: API failures return ok:false with the error
 * message; caller decides how to surface (audit row + Review tab).
 */
export async function registerGlofoxMember(creds, payload) {
  if (!creds?.branchId) {
    return { ok: false, member: null, error: 'missing branchId' }
  }
  if (!payload?.first_name || !payload?.last_name || !payload?.email || !payload?.password) {
    return { ok: false, member: null, error: 'missing required fields (first_name, last_name, email, password)' }
  }
  const body = {
    first_name: payload.first_name,
    last_name: payload.last_name,
    email: String(payload.email).trim().toLowerCase(),
    type: 'MEMBER',
    lead_status: payload.lead_status || 'LEAD',
    password: payload.password,
    ...(payload.phone ? { phone: payload.phone } : {}),
    ...(payload.birth ? { birth: payload.birth } : {}),
    ...(payload.emergency_contact ? { emergency_contact: payload.emergency_contact } : {}),
    ...(payload.consent ? { consent: payload.consent } : {}),
  }
  try {
    const r = await glofoxFetch(creds, '/2.0/register', {
      method: 'POST',
      // MUST set this: without it fetch sends the body as text/plain and Glofox
      // never parses the JSON, rejecting every field as "required" (and the new
      // member is never created → the booking dead-ends in staff review). Mirrors
      // createBooking, the working POST.
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let parsed
    try { parsed = await r.json() } catch { parsed = null }
    if (!r.ok) {
      return {
        ok: false,
        member: null,
        error: parsed?.error || parsed?.message || `Glofox HTTP ${r.status}`,
        glofox_response: parsed,
      }
    }
    // Glofox wraps the new user under various shapes — try them.
    const member = parsed?.user || parsed?.data || parsed
    return { ok: true, member, error: null, glofox_response: parsed }
  } catch (e) {
    return { ok: false, member: null, error: e?.message || 'network error' }
  }
}

/**
 * Update an existing Glofox member via PUT /2.0/members/{userId}.
 *
 * Per the spec: "Only send the fields you want to change". We
 * pass through whatever the caller hands us, no field-shape
 * validation (caller is responsible for sending the right keys).
 */
export async function updateGlofoxMember(creds, userId, patch) {
  if (!creds?.branchId || !userId) {
    return { ok: false, error: 'missing args' }
  }
  if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
    return { ok: false, error: 'empty patch' }
  }
  try {
    const r = await glofoxFetch(creds, `/2.0/members/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    let parsed
    try { parsed = await r.json() } catch { parsed = null }
    if (!r.ok) {
      return { ok: false, error: parsed?.error || parsed?.message || `Glofox HTTP ${r.status}`, glofox_response: parsed }
    }
    return { ok: true, glofox_response: parsed }
  } catch (e) {
    return { ok: false, error: e?.message || 'network error' }
  }
}

/**
 * Purchase a membership for a member via the cart-less direct
 * purchase endpoint:
 *   POST /2.2/branches/{branchId}/users/{userId}/memberships/{membershipId}/plans/{planCode}/purchase
 *
 * Used immediately after registerGlofoxMember to attach the
 * studio's trial membership to a fresh account. Per-location
 * trial config lives at locations.settings.glofox.trial_membership_id
 * + trial_plan_code.
 *
 * Returns { ok, error, glofox_response }.
 */
export async function purchaseGlofoxMembership(creds, userId, membershipId, planCode, opts = {}) {
  if (!creds?.branchId || !userId || !membershipId || !planCode) {
    return { ok: false, error: 'missing args' }
  }
  const path = `/2.2/branches/${encodeURIComponent(creds.branchId)}/users/${encodeURIComponent(userId)}/memberships/${encodeURIComponent(membershipId)}/plans/${encodeURIComponent(planCode)}/purchase`
  try {
    const r = await glofoxFetch(creds, path, {
      method: 'POST',
      // Declare the JSON body's content-type (as createBooking/register do).
      // The trial purchase is the next call after register in the booking flow;
      // the body is empty today, but set it so Glofox can't ignore a body we
      // later add — the exact class of bug that broke registration.
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body || {}),
    })
    let parsed
    try { parsed = await r.json() } catch { parsed = null }
    if (!r.ok) {
      return { ok: false, error: parsed?.message || `Glofox HTTP ${r.status}`, glofox_response: parsed }
    }
    return { ok: true, glofox_response: parsed }
  } catch (e) {
    return { ok: false, error: e?.message || 'network error' }
  }
}

/**
 * List the membership catalog at the studio via GET /2.0/memberships.
 *
 * Used by the LocationForm trial-membership picker — operator
 * picks one (membership + plan_code combo) to use as the trial
 * product for new Glofox accounts at this location.
 *
 * Returns { ok, memberships: [{ _id, name, plans: [{ code, type, price }] }] }
 * or { ok: false, error }.
 */
export async function listGlofoxMemberships(creds) {
  if (!creds?.branchId) return { ok: false, error: 'missing branchId', memberships: [] }
  try {
    const r = await glofoxFetch(creds, '/2.0/memberships')
    if (!r.ok) return { ok: false, error: `Glofox HTTP ${r.status}`, memberships: [] }
    const body = await r.json()
    const items = Array.isArray(body?.data) ? body.data
                : Array.isArray(body) ? body
                : []
    const memberships = items.map(m => ({
      _id: String(m?._id || ''),
      name: String(m?.name || ''),
      trial: m?.trial === true,
      plans: Array.isArray(m?.plans) ? m.plans.map(p => ({
        code: String(p?.code || ''),
        type: String(p?.type || ''),
        price: Number(p?.price) || 0,
        name: String(p?.name || ''),
      })).filter(p => p.code) : [],
    })).filter(m => m._id)
    return { ok: true, memberships }
  } catch (e) {
    return { ok: false, error: e?.message || 'network error', memberships: [] }
  }
}

/**
 * Generate a one-time passcode for a new Glofox account. Used as
 * the initial password on /2.0/register; emailed (and SMS'd) to the
 * member as "log in once with this, change to your own password."
 *
 * Glofox enforces a multi-class password policy (live failure 2026-06-30:
 * PASSWORD_RULE_LOWER_CASE — the old uppercase+digits-only alphabet could
 * never produce a lowercase letter, so every brand-new lead's account
 * creation failed). Every output is now GUARANTEED to contain >=1 lowercase,
 * >=1 uppercase, >=1 digit, and a hyphen (the special char Glofox already
 * accepted). 8 alphanumeric chars, hyphenated XXXX-XXXX for readability
 * (e.g. 'Abc4-K7np'). Crypto-random. Visually-ambiguous chars (0/O/o, 1/I/l)
 * are excluded from every class so the member can retype it.
 */
export function generateGlofoxPasscode() {
  const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ' // A-Z minus I, L, O
  const LOWER = 'abcdefghijkmnpqrstuvwxyz' // a-z minus l, o
  const DIGIT = '23456789' // 2-9 minus 0, 1
  const ALL = UPPER + LOWER + DIGIT
  const pick = (str) => str[randIndex(str.length)]

  // One guaranteed char from each class (deterministic, so no output can ever
  // miss a class), then fill the rest from the union and shuffle.
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT)]
  while (chars.length < 8) chars.push(pick(ALL))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randIndex(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  // XXXX-XXXX — the hyphen doubles as the special char Glofox already accepts.
  return chars.slice(0, 4).join('') + '-' + chars.slice(4).join('')
}

/**
 * Crypto-strong, unbiased integer in [0, n). Rejection-samples a byte so there
 * is no modulo bias (the old `byte % 31` slightly favoured low indices). Uses
 * the global Web Crypto API (Edge/Node 18+/browser) with a Math.random
 * fallback. n must be <= 256.
 */
function randIndex(n) {
  const limit = Math.floor(256 / n) * n // largest multiple of n <= 256
  const buf = new Uint8Array(1)
  const hasCrypto = typeof crypto !== 'undefined' && crypto.getRandomValues
  for (;;) {
    if (hasCrypto) crypto.getRandomValues(buf)
    else buf[0] = Math.floor(Math.random() * 256)
    if (buf[0] < limit) return buf[0] % n
  }
}

/**
 * UIX-P3b — the BookingRequest model value for booking a member into
 * a class. LIVE-PROBED 2026-06-11 (booking_dryrun): POST /2.0/bookings
 * with { user_id, event_id } resolved (no WRONG_URL — bookings exist
 * on this tier) but validation answered "The model field is required.,
 * The model id field is required." and did NOT flag user_id — so the
 * real shape is { user_id, model, model_id } (polymorphic target).
 * LIVE-CONFIRMED 2026-06-11: the operator's real class booking
 * SUCCEEDED via the book route's self-discovery sweep after 'Event'
 * failed the enum ("The selected model is invalid") — so the
 * accepted token is one of the lowercase candidates. 'event' is the
 * sweep's preferred event-family value; if Glofox's enum actually
 * uses a different spelling the self-discovery fallback in
 * /api/glofox/classes/book still corrects it at runtime (one ~4s
 * sweep), so a wrong constant degrades to slow, never broken.
 */
export const GLOFOX_BOOKING_MODEL = 'event'

/**
 * Create a booking on behalf of a member via /2.0/bookings.
 *
 * Body is passed through verbatim — per the 2026-06-11 dry-run the
 * accepted shape is { user_id, model, model_id } (see
 * GLOFOX_BOOKING_MODEL above; the old { user_id, event_id } guess
 * fails validation). Glofox enforces capacity, double-book
 * prevention, and waitlist behaviour server-side — error responses
 * include a message_code (e.g. YOU_HAVE_BOOKED_FOR_THIS_EVENT,
 * EVENT_HAS_BEEN_CANCELLED) so the caller can surface what went wrong.
 *
 * Returns the parsed JSON response. status + ok hoisted onto the
 * return so the operator-facing endpoint can route on them.
 */
export async function createBooking(creds, bookingRequest) {
  if (!creds || !bookingRequest) return { ok: false, status: 400, body: { error: 'missing args' } }
  try {
    const r = await glofoxFetch(creds, '/2.0/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bookingRequest),
    })
    let body
    try { body = await r.json() } catch { body = null }
    return { ok: r.ok, status: r.status, body }
  } catch (e) {
    return { ok: false, status: 0, body: { error: e?.message || 'network error' } }
  }
}

export const GLOFOX_ALREADY_BOOKED_CODE = 'YOU_HAVE_BOOKED_FOR_THIS_EVENT'

/**
 * Interpret a createBooking result. Glofox returns HTTP 200 with a
 * failure body (message_code YOU_HAVE_NO_CREDITS_LEFT — seen live
 * 2026-07-27) when the member cannot book, so HTTP ok alone is NOT
 * booking success.
 *
 * MIA-BOOK.2 — but an id-REQUIRED rule is too strict the other way:
 * Glofox's live success body has NEVER matched the harvest shapes below
 * (0/9 historical funnel bookings captured an id; Emma Kennedy
 * 2026-07-28 booked fine on a 200 we then mislabelled a failure). So:
 *   - a 2xx WITH a message code is only booked when an id came back too
 *     (the 200-with-error shape — the Lucinda case stays a failure);
 *   - a CLEAN 2xx (no message code) is booked, id or not — the id is a
 *     reconciliation bonus, never the success gate. When a clean 2xx has
 *     no harvestable id we log the body keys once so the real success
 *     shape can be added to the harvest list.
 *
 * `alreadyBooked` flags Glofox's server-side member+event dedupe:
 * `booked` stays false (no new booking id comes back), but most callers
 * should treat it as success — the member IS in the class (e.g. a re-run
 * whose first attempt landed, or staff booked manually before approving
 * a pending fallback card).
 *
 * Returns { booked, bookingId, messageCode, alreadyBooked }.
 */
export function interpretBookingResult(result) {
  const body = result?.body
  const bookingId = body?._id || body?.id || body?.booking_id || body?.data?._id || body?.data?.id || null
  const messageCode = body?.message_code || body?.message || null
  const alreadyBooked = messageCode === GLOFOX_ALREADY_BOOKED_CODE
  const booked = !!result?.ok && (!messageCode || !!bookingId)
  if (booked && !bookingId) {
    const keys = body && typeof body === 'object' ? Object.keys(body).join(',') : typeof body
    console.warn(`[glofox] booking 2xx without a harvestable id — extend the harvest shapes. body keys: ${keys || 'empty'}`)
  }
  return { booked, bookingId, messageCode, alreadyBooked }
}

/**
 * UIX-P3b — upcoming classes for the unified inbox's Book tab.
 *
 * VERIFIED against the live Stillorgan branch
 * (/api/glofox/probe?check=events_discovery, 2026-06-11):
 * GET /2.0/events?start=<unix-secs>&end=<unix-secs>&limit=N → 200 with
 * { object:'list', page, limit, has_more, total_count, data:[event] };
 * the time window is honoured (windowed and unwindowed calls return
 * different first items). Event fields seen live: _id, name,
 * description, time_start, duration, size, booked, waiting, trainers,
 * active, private, booking_status, program_obj, …
 * (/2.0/calendar does NOT exist on this tier — WRONG_URL.)
 *
 * Returns { ok, status, body, events } — events is body.data or [].
 */
export async function fetchUpcomingEvents(creds, { start, end, limit = 100 } = {}) {
  if (!creds) return { ok: false, status: 400, body: { error: 'missing creds' }, events: [] }
  const now = Math.floor(Date.now() / 1000)
  const qs = new URLSearchParams({
    start: String(start ?? now),
    end:   String(end ?? now + 7 * 86400),
    limit: String(limit),
  })
  try {
    const r = await glofoxFetch(creds, `/2.0/events?${qs.toString()}`)
    let body
    try { body = await r.json() } catch { body = null }
    const events = Array.isArray(body?.data) ? body.data : []
    return { ok: r.ok, status: r.status, body, events }
  } catch (e) {
    return { ok: false, status: 0, body: { error: e?.message || 'network error' }, events: [] }
  }
}

/**
 * Cancel a booking via POST /booking/{bookingId}/user/{userId}/cancel.
 * Studios can configure "no cancellation allowed within X hours of class"
 * — Glofox returns the rule violation message in the response body.
 */
export async function cancelBooking(creds, bookingId, userId) {
  if (!creds || !bookingId || !userId) {
    return { ok: false, status: 400, body: { error: 'missing args' } }
  }
  try {
    const r = await glofoxFetch(
      creds,
      `/booking/${encodeURIComponent(bookingId)}/user/${encodeURIComponent(userId)}/cancel`,
      { method: 'POST' },
    )
    let body
    try { body = await r.json() } catch { body = null }
    return { ok: r.ok, status: r.status, body }
  } catch (e) {
    return { ok: false, status: 0, body: { error: e?.message || 'network error' } }
  }
}

// ─────────────────────────────────────────────────────────────
// Membership cancellation (CANCEL-FORM.1)
// ─────────────────────────────────────────────────────────────
//
// docs/LESSONS.md: POST /v3.0/memberships/{userMembershipId}/cancel is the
// one membership WRITE Glofox documents. Facts that shape this client:
//   - only `when: 'ON_DATE'` works (NOW / END_OF_CYCLE are spec-annotated
//     "not supported yet");
//   - the call is member-initiated, so it REQUIRES the
//     x-glofox-impersonated-member-id header (the member's Glofox _id);
//   - a malformed id makes Glofox's router answer WRONG_URL before the
//     route resolves, which reads exactly like "no such endpoint" — so
//     ids are shape-checked here and never sent malformed;
//   - `userMembershipId` is the per-member membership INSTANCE id from
//     GET /2.0/members/{id} → membership.user_membership_id, distinct from
//     the catalog membershipId.
// Pause has a live sibling route that REJECTS impersonation and has no
// documented body — it is deliberately not automated.

const GLOFOX_OBJECT_ID_RE = /^[0-9a-f]{24}$/i
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/

// Form reason codes → Glofox's MembershipCancellationRequest.reason enum.
// Codes with no Glofox equivalent map to '' (the spec allows the empty
// string); the customer's own words travel on the request row instead.
export const GLOFOX_CANCELLATION_REASONS = Object.freeze({
  price: 'MEMBERSHIP_CANCELLATION_PRICE',
  moving: 'MEMBERSHIP_CANCELLATION_MOVED',
  not_using: 'MEMBERSHIP_CANCELLATION_NO_USAGE',
  service: 'MEMBERSHIP_CANCELLATION_CUSTOMER_SERVICE',
  schedule: 'MEMBERSHIP_CANCELLATION_EVENT_SCHEDULE',
  change_membership: 'MEMBERSHIP_CANCELLATION_CHANGE_MEMBERSHIP',
  injury_health: '',
  other: '',
})
const GLOFOX_CANCELLATION_REASON_VALUES = new Set(Object.values(GLOFOX_CANCELLATION_REASONS))

export function glofoxCancellationReason(code) {
  return Object.prototype.hasOwnProperty.call(GLOFOX_CANCELLATION_REASONS, code)
    ? GLOFOX_CANCELLATION_REASONS[code]
    : ''
}

/**
 * Resolve the per-member membership instance id the cancel endpoint
 * addresses. Falls back on a live single-member GET because the bulk
 * list sync never carried it (contacts.glofox_user_membership_id is only
 * populated once the detail sync has touched the row).
 * @returns {Promise<string|null>}
 */
export async function resolveUserMembershipId(creds, memberId) {
  if (!creds || !memberId) return null
  const { ok, member } = await fetchMemberResult(creds, memberId)
  if (!ok || !member) return null
  const id = member.membership && typeof member.membership === 'object'
    ? member.membership.user_membership_id
    : null
  return typeof id === 'string' && id ? id : null
}

/**
 * Cancel a member's membership ON a date. Never throws.
 *
 * @param {object} creds
 * @param {{userMembershipId:string, memberId:string, localDate:string, reason?:string}} args
 *   reason must be a value of GLOFOX_CANCELLATION_REASONS (default '').
 * @returns {Promise<{ok:boolean, status:number, message_code:(string|null), local_planned_end_date:(string|null), body:any}>}
 *   message_code is Glofox's own code (body.message_code, else body.message)
 *   kept verbatim so the approval card can show it; INVALID_ARGS and
 *   NETWORK_ERROR are ours.
 */
export async function cancelGlofoxMembership(creds, { userMembershipId, memberId, localDate, reason = '' } = {}) {
  const invalid = !creds
    || !GLOFOX_OBJECT_ID_RE.test(String(userMembershipId || ''))
    || !GLOFOX_OBJECT_ID_RE.test(String(memberId || ''))
    || !ISO_DAY_RE.test(String(localDate || ''))
    || !GLOFOX_CANCELLATION_REASON_VALUES.has(reason)
  if (invalid) {
    return { ok: false, status: 400, message_code: 'INVALID_ARGS', local_planned_end_date: null, body: null }
  }
  try {
    const r = await glofoxFetch(creds, `/v3.0/memberships/${userMembershipId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-glofox-impersonated-member-id': memberId,
      },
      body: JSON.stringify({ when: 'ON_DATE', local_date: localDate, reason }),
    })
    let body
    try { body = await r.json() } catch { body = null }
    const payload = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body
    const plannedEnd = payload && typeof payload.local_planned_end_date === 'string' ? payload.local_planned_end_date : null
    const messageCode = body && typeof body === 'object'
      ? (typeof body.message_code === 'string' ? body.message_code : (typeof body.message === 'string' ? body.message : null))
      : null
    return { ok: r.ok, status: r.status, message_code: r.ok ? (messageCode ?? null) : messageCode, local_planned_end_date: r.ok ? plannedEnd : null, body }
  } catch (e) {
    return { ok: false, status: 0, message_code: 'NETWORK_ERROR', local_planned_end_date: null, body: { error: e?.message || 'network error' } }
  }
}

/**
 * Fetch a Glofox member's interactions log via
 * /2.1/branches/{branchId}/leads/{userId}/interactions.
 *
 * Per the spec, an Interaction has:
 *   _id, branch_id, user_id, description, created (Unix sec)
 *   type: NOTE | CALLED_AND_CONNECTED | CALLED_AND_NO_ANSWER | MANUAL_EMAIL
 *
 * Returns the data array (Interaction[]) or [] on failure.
 * Best-effort — failures don't bubble (the contact still syncs).
 */
export async function fetchUserInteractions(creds, userId) {
  if (!creds || !userId || !creds.branchId) return []
  try {
    const r = await glofoxFetch(
      creds,
      `/2.1/branches/${encodeURIComponent(creds.branchId)}/leads/${encodeURIComponent(userId)}/interactions`,
    )
    if (!r.ok) return []
    const body = await r.json()
    if (Array.isArray(body)) return body
    if (Array.isArray(body?.data)) return body.data
    return []
  } catch {
    return []
  }
}

/**
 * Create a Glofox interaction (note / manual email) for a user via
 * POST /2.1/branches/{branchId}/leads/{userId}/interactions.
 *
 * Glofox accepts only type NOTE or MANUAL_EMAIL on create, description
 * <= 500 chars. The response has NO body (the created interaction id is
 * not returned) — reconciliation happens later via the inbound pull +
 * the glofox_note_pushes ledger. Best-effort: returns { ok, status }.
 */
export async function createGlofoxInteraction(creds, userId, { type, description } = {}) {
  if (!creds || !creds.branchId || !userId || !type) return { ok: false, status: 0 }
  try {
    const r = await glofoxFetch(
      creds,
      `/2.1/branches/${encodeURIComponent(creds.branchId)}/leads/${encodeURIComponent(userId)}/interactions`,
      {
        method: 'POST',
        // Required: without it fetch sends the body as text/plain, Glofox never
        // parses the JSON and rejects every field as "required" (the exact bug
        // that broke registration). Mirrors registerGlofoxMember/createBooking.
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, type, description: description ?? '' }),
      },
    )
    return { ok: r.ok, status: r.status }
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || 'network error' }
  }
}

/**
 * Fetch a Glofox member's recent bookings via /2.0/bookings.
 *
 * Per the spec, the endpoint is paginated (limit defaults 50, max
 * 100). For engagement-aggregate purposes we want the last ~30 days
 * of activity — defaults to ~30d window via time_start. Caller can
 * override.
 *
 * Returns the data array (Booking[]) or [] on failure / no data.
 * Best-effort: a network or auth failure here returns [] so the
 * containing sync can still write the contact + skip booking
 * aggregates (next sync will fill them in).
 *
 * @param {object} creds  per-location credentials
 * @param {string} userId Glofox member _id
 * @param {object} [opts]
 * @param {string} [opts.branchId]   override branch (defaults to creds.branchId)
 * @param {number} [opts.windowDays] history window in days (default 30)
 * @param {number} [opts.limit]      page size (default 100, max 100)
 */
export async function fetchUserBookings(creds, userId, opts = {}) {
  return (await fetchUserBookingsResult(creds, userId, opts)).bookings
}

/**
 * Error-aware variant of fetchUserBookings.
 *
 * fetchUserBookings collapses "no bookings" and "request failed"
 * into the same []. That's fine for the delta sync (which writes
 * the contact regardless), but a full attendance refresh must NOT
 * overwrite a member's aggregates with zeros on a transient Glofox
 * error. This variant reports which it was:
 *
 *   { ok: true,  bookings: [...] }  — request succeeded (may be empty)
 *   { ok: false, bookings: [] }     — request failed; caller should
 *                                     skip and retry on the next run
 *
 * @returns {Promise<{ ok: boolean, bookings: Array }>}
 */
export async function fetchUserBookingsResult(creds, userId, opts = {}) {
  if (!creds || !userId) return { ok: false, bookings: [] }
  const branchId = opts.branchId || creds.branchId
  if (!branchId) return { ok: false, bookings: [] }
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : 30
  const limit = Math.min(opts.limit || 100, 100)
  const cutoffSec = Math.floor((Date.now() - windowDays * 24 * 60 * 60 * 1000) / 1000)
  // sort_by=-created → newest first; time_start filters by class
  // start time (not booking creation), but the cutoff still bounds
  // historical scope. exclude_cancelled=false so we can count
  // cancellations toward the bookings_30d aggregate too.
  const qs = new URLSearchParams({
    branchId,
    user_id: userId,
    limit: String(limit),
    page: '1',
    sort_by: '-created',
    time_start: String(cutoffSec),
    exclude_cancelled: 'false',
  })
  try {
    const r = await glofoxFetch(creds, `/2.0/bookings?${qs.toString()}`)
    if (!r.ok) return { ok: false, bookings: [] }
    const body = await r.json()
    return { ok: true, bookings: Array.isArray(body?.data) ? body.data : [] }
  } catch {
    return { ok: false, bookings: [] }
  }
}

/**
 * STUDIO-KPI.4 — a Glofox user's display name. Event payloads carry
 * only trainer ids (trainers_obj arrives empty), so trainer names are
 * resolved via the API and this picks the name off whatever user/
 * trainer shape comes back.
 */
export function glofoxDisplayName(user) {
  if (!user || typeof user !== 'object') return null
  if (typeof user.name === 'string' && user.name.trim()) return user.name.trim()
  const joined = [user.first_name, user.last_name]
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim())
    .join(' ')
  return joined || null
}

/**
 * STUDIO-KPI.4 — best-effort trainer list via GET /2.0/trainers.
 * UNPROBED endpoint: it may not exist on this Glofox tier (like
 * /2.0/calendar, which WRONG_URLs). Any failure returns [] and the
 * caller falls back to per-id /2.0/members lookups — trainers are
 * users in Glofox's model, so their ids resolve there.
 */
export async function fetchGlofoxTrainers(creds) {
  if (!creds?.branchId) return []
  try {
    const r = await glofoxFetch(creds, '/2.0/trainers?limit=100')
    if (!r.ok) return []
    const body = await r.json()
    return Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : [])
  } catch {
    return []
  }
}

/**
 * Error-aware single-member fetch — GET /2.0/members/{id}.
 *
 * The /2.0/members LIST payload carries only a thin membership
 * object (no membership_plan_name / status); the single-member
 * endpoint carries the full one. Used by the attendance-refresh
 * cron to keep contacts.glofox_membership_plan current for the
 * whole member base.
 *
 *   { ok: true,  member: {...} }  — request succeeded
 *   { ok: false, member: null }   — request failed; caller should
 *                                   leave the member's stored data
 *                                   untouched (don't wipe to null)
 *
 * @returns {Promise<{ ok: boolean, member: (object|null) }>}
 */
export async function fetchMemberResult(creds, memberId) {
  if (!creds || !memberId) return { ok: false, member: null }
  try {
    const r = await glofoxFetch(creds, `/2.0/members/${encodeURIComponent(memberId)}`)
    if (!r.ok) return { ok: false, member: null }
    const body = await r.json()
    // The single-member endpoint wraps the member under `data`;
    // tolerate an unwrapped body too.
    const member = body && typeof body === 'object' && body.data ? body.data : body
    return { ok: true, member: (member && typeof member === 'object') ? member : null }
  } catch {
    return { ok: false, member: null }
  }
}
