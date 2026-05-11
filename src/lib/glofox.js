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

/**
 * Fetch a paginated list of leads/members from a branch via
 * POST /2.1/branches/{branchId}/leads/filter.
 *
 * Per the spec, UserFilters supports:
 *   lead_status: array of LEAD/TRIAL/COLD/MEMBER/NO_SALE_TRIAL/TOUR/NO_SALE_TOUR
 *   source:      array of MEMBER_APP/CLASSPASS/DASHBOARD/etc.
 *   created:     { start, end } — Unix seconds
 *   modified:    { start, end } — Unix seconds
 *   name:        string — searches name/first_name/last_name/email/phone
 *   deleted:     boolean — default false (active users only)
 *
 * Pagination via { skip, limit } in the body. limit max per page
 * is server-defined (typically 50–100); paginate by re-calling.
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
 */
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
  const body = {
    branch_id: creds.branchId,
    namespace: opts.namespace,
    start: String(startSec),
    end: String(endSec),
    model: opts.model || 'TransactionsList',
    filter: {
      ReportByMembers: opts.byMembers === true,
      CompareToRanges: false,
      ...(opts.paymentMethods ? { PaymentMethods: opts.paymentMethods } : {}),
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

/**
 * Create a booking on behalf of a member via /2.0/bookings.
 *
 * Per the spec the request body is a BookingRequest. Real-world
 * minimum: { user_id, event_id }. Glofox enforces capacity, double-
 * book prevention, and waitlist behaviour server-side — error
 * responses include a message_code (e.g. YOU_HAVE_BOOKED_FOR_THIS_EVENT,
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
      body: JSON.stringify(bookingRequest),
    })
    let body
    try { body = await r.json() } catch { body = null }
    return { ok: r.ok, status: r.status, body }
  } catch (e) {
    return { ok: false, status: 0, body: { error: e?.message || 'network error' } }
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
  if (!creds || !userId) return []
  const branchId = opts.branchId || creds.branchId
  if (!branchId) return []
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
    if (!r.ok) return []
    const body = await r.json()
    return Array.isArray(body?.data) ? body.data : []
  } catch {
    return []
  }
}
