// INTEG-B3 — tenant email SEND-PATH resolver + add-on gate + redacting
// payload shaper (server-per-tenant sending domains).
//
// THE RISKY PART. resolveEmailSender() sits in the live email send path
// (src/lib/postmark.js sendEmail/sendBatch). Its ONE job: given a
// locationId, decide whether that location's org has a LIVE tenant email
// domain and, if so, hand back that org's Postmark server token + verified
// From — otherwise the PRE-DOMAIN sender (W1.E2): the shared
// POSTMARK_API_KEY server, the platform address (POSTMARK_FROM_EMAIL, never
// spelled here), the tenant's BRAND as display name and the location's own
// address as Reply-To. Nothing says UN1T: a second gym's customers read their
// gym's name on every email before the gym has verified a domain of its own.
//
// FAIL SAFE, ALWAYS. It NEVER throws. A billing/config/DB bug must never
// stop a booking confirmation going out — every error path resolves to the
// global default (platform address + PLATFORM_NAME, no reply-to).
//
// SECRET: the resolved serverToken is the org's Postmark server token (see
// mig 427). It is used ONLY to set the X-Postmark-Server-Token header. It
// is never logged and never returned to a client.

import { locationHasPlanFeature } from '@/lib/plans'
import { getLocationBranding } from '@/lib/location-branding'
import { getLocationInboxReplyTo } from '@/lib/postmark-reply-to'
import { PLATFORM_NAME } from '@/lib/brand-name'
import { platformFromAddress } from '@/lib/platform-sender'

// Small in-request cache: a campaign blasting 500 recipients would
// otherwise re-resolve the same location on every send. Keyed by
// locationId; the value is the WHOLE resolved sender (W1.E2: the tenant row's
// token + From, or the platform sender with the brand and reply-to resolved),
// with a short TTL so a connect/disconnect or a brand edit self-heals within
// a minute. The cached sender can contain the secret server token — this is
// a service-role, server-side cache in the send path (the token is already
// in memory there); it is never serialised out.
const SENDER_CACHE_TTL_MS = 60_000
const senderCache = new Map()

/** Test hook — clears the module-level sender cache between tests. */
export function _resetTenantEmailCache() {
  senderCache.clear()
}

/**
 * The GLOBAL DEFAULT sender: serverToken null (caller falls back to
 * getPostmarkToken() = POSTMARK_API_KEY), the platform ADDRESS from
 * POSTMARK_FROM_EMAIL (parsed: a "Name <addr>" value yields the address, its
 * name is never used), PLATFORM_NAME as display name, no reply-to. This is
 * what a send with no location gets, and what any resolver error falls back
 * to. Read from env fresh each call so it always reflects the live config.
 * Pure.
 * @returns {{ serverToken: null, fromEmail: string|null, fromName: string, replyTo: null }}
 */
export function globalDefaultSender() {
  return {
    serverToken: null,
    fromEmail: platformFromAddress(),
    fromName: PLATFORM_NAME,
    replyTo: null,
  }
}

/**
 * Build a sender from a LIVE tenant_email_domains row. Pure. Returns the
 * global default when the row is missing its server token (defensive —
 * a live row should always have one). replyTo is null here: the caller
 * (resolveEmailSender) adds the location's reply-to on top.
 * @param {{ postmark_server_token?: string, from_email?: string, from_name?: string }|null} row
 */
export function senderFromRow(row) {
  if (!row?.postmark_server_token) return globalDefaultSender()
  return {
    serverToken: row.postmark_server_token,
    fromEmail: row.from_email || platformFromAddress(),
    fromName: row.from_name || null,
    replyTo: null,
  }
}

// W1.E2 — the PRE-DOMAIN sender: platform address, tenant display name,
// tenant reply-to. Nothing says UN1T. The brand is the W1.B1 chain
// (company_settings → org_settings → locations.name); a brand the chain
// cannot resolve at all falls to PLATFORM_NAME rather than another gym's.
// getLocationBranding never throws.
async function platformSenderFor(db, locationId, replyTo) {
  const branding = await getLocationBranding(db, locationId)
  return {
    serverToken: null,
    fromEmail: platformFromAddress(),
    fromName: (branding?.companyName || '').trim() || PLATFORM_NAME,
    replyTo: replyTo || null,
  }
}

// Load the LIVE tenant row for a location (location → org → row), or null
// when there is no live tenant config. Returns null on ANY error — the
// caller (resolveEmailSender) then serves the global default.
async function loadLiveRowForLocation(db, locationId) {
  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr || !loc?.organization_id) return null

  const { data: row, error: rowErr } = await db
    .from('tenant_email_domains')
    .select('postmark_server_token, from_email, from_name, status')
    .eq('organization_id', loc.organization_id)
    .eq('status', 'live')
    .maybeSingle()
  if (rowErr || !row) return null
  return row
}

/**
 * Resolve the sender for a send. NEVER throws.
 *
 *   locationId absent / no db  → global default (no lookup at all)
 *   location → org → LIVE row  → that org's server token + verified From,
 *                                 replyTo = the location's address
 *   no live row (W1.E2)        → platform address, the location's BRAND as
 *                                 display name, replyTo = the location's address
 *   ANY error                  → global default
 *
 * replyTo (W1.E2) is getLocationInboxReplyTo: the default email account →
 * the deprecated locations.email_inbox_reply_to → locations.email → null.
 * The caller's own replyTo always wins over it.
 *
 * @param {object} db - service-role client (createServerClient())
 * @param {string|null|undefined} locationId
 * @returns {Promise<{ serverToken: string|null, fromEmail: string|null, fromName: string|null, replyTo: string|null }>}
 */
export async function resolveEmailSender(db, locationId) {
  if (!db || !locationId) return globalDefaultSender()
  try {
    const cached = senderCache.get(locationId)
    if (cached && cached.expiresAt > Date.now()) return { ...cached.sender }
    const row = await loadLiveRowForLocation(db, locationId)
    const replyTo = await getLocationInboxReplyTo(db, locationId)
    // A live row with no token (defensive; should not exist) is not a tenant
    // sender — it falls to the branded platform sender, never to a bare one.
    const sender = row?.postmark_server_token
      ? { ...senderFromRow(row), replyTo: replyTo || null }
      : await platformSenderFor(db, locationId, replyTo)
    senderCache.set(locationId, { sender, expiresAt: Date.now() + SENDER_CACHE_TTL_MS })
    return { ...sender }
  } catch {
    // FAIL SAFE — a resolver bug must never break a send.
    return globalDefaultSender()
  }
}

// ─────────────────────────────────────────────────────────────
// Add-on gate (the wizard is reachable only when the org's plan
// has the custom_email_domain feature active)
// ─────────────────────────────────────────────────────────────

/**
 * True when ANY active location of the org holds an active pin (tier OR
 * add-on) whose features include custom_email_domain. Plans are pinned
 * per LOCATION (mig 413) but the sending domain is per ORG, so an org
 * "has" the add-on if any of its locations does.
 *
 * W1.E1 — judged by locationHasPlanFeature, which reads the pins directly.
 * It used to go through getLocationPlan(), which answers null without a
 * TIER pin, so an add-on-only pin (the live Test Studio pin) granted
 * nothing and the feature stayed unreachable. The sending domain is a
 * PAID plan feature (decision 1): the gate stays, master included.
 *
 * FAIL CLOSED — this gates provisioning of PAID resources, so any error
 * (or no pin) resolves to false (feature off).
 *
 * @param {object} db - service-role client
 * @param {string} orgId
 * @returns {Promise<boolean>}
 */
export async function orgHasEmailDomainAddon(db, orgId) {
  if (!db || !orgId) return false
  try {
    const { data: locs, error } = await db
      .from('locations')
      .select('id')
      .eq('organization_id', orgId)
      .eq('active', true)
    if (error || !Array.isArray(locs)) return false
    for (const loc of locs) {
      if (await locationHasPlanFeature(db, loc.id, 'custom_email_domain')) return true
    }
    return false
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────
// Client-facing payload — the ONLY shape routes return.
// NEVER includes postmark_server_token (mig 427 secret).
// ─────────────────────────────────────────────────────────────

/**
 * The DNS records the operator adds at their registrar, built from the
 * persisted columns. Entries missing a name or value are omitted. Pure.
 * @param {object|null} row
 */
export function dnsRecordsFromRow(row) {
  const records = []
  if (row?.dkim_pending_host && row?.dkim_pending_value) {
    records.push({ purpose: 'DKIM', type: 'TXT', name: row.dkim_pending_host, value: row.dkim_pending_value })
  }
  if (row?.return_path_domain && row?.return_path_cname_value) {
    records.push({ purpose: 'Return-Path', type: 'CNAME', name: row.return_path_domain, value: row.return_path_cname_value })
  }
  return records
}

/**
 * REDACTED status payload for the caller's org. Deliberately constructs an
 * explicit allowlist of fields — the server token can never leak through
 * an accidental spread. Pure.
 * @param {object|null} row - tenant_email_domains row (may be null)
 * @param {{ addonActive?: boolean, accountConfigured?: boolean }} [meta]
 */
export function tenantEmailStatePayload(row, meta = {}) {
  const base = {
    addon_active: !!meta.addonActive,
    account_configured: !!meta.accountConfigured,
  }
  if (!row) {
    return { ...base, status: 'not_configured', sending_domain: null, from_email: null, from_name: null, dkim_verified: false, return_path_verified: false, records: [], last_error: null, webhooks_registered: false }
  }
  return {
    ...base,
    status: row.status,
    sending_domain: row.sending_domain ?? null,
    from_email: row.from_email ?? null,
    from_name: row.from_name ?? null,
    dkim_verified: !!row.dkim_verified,
    return_path_verified: !!row.return_path_verified,
    records: dnsRecordsFromRow(row),
    last_error: row.last_error ?? null,
    // W1.E3 (mig 718) — the broadcast stream + six-trigger webhooks exist on
    // the org's server. A boolean: the timestamp stays on the row.
    webhooks_registered: !!row.webhooks_registered_at,
  }
}
