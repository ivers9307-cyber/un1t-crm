// INTEG-B3 — tenant email SEND-PATH resolver + add-on gate + redacting
// payload shaper (server-per-tenant sending domains).
//
// THE RISKY PART. resolveEmailSender() sits in the live email send path
// (src/lib/postmark.js sendEmail/sendBatch). Its ONE job: given a
// locationId, decide whether that location's org has a LIVE tenant email
// domain and, if so, hand back that org's Postmark server token + verified
// From — otherwise the GLOBAL DEFAULT (the shared POSTMARK_API_KEY server +
// POSTMARK_FROM_EMAIL).
//
// FAIL SAFE, ALWAYS. It NEVER throws. A billing/config/DB bug must never
// stop a booking confirmation going out — every error path resolves to the
// global default, i.e. exactly today's behaviour. With the table empty
// (every org today) it returns the global default for every call, so the
// send path is byte-identical to before this feature existed.
//
// SECRET: the resolved serverToken is the org's Postmark server token (see
// mig 427). It is used ONLY to set the X-Postmark-Server-Token header. It
// is never logged and never returned to a client.

import { getLocationPlan } from '@/lib/plans'

// Small in-request cache: a campaign blasting 500 recipients would
// otherwise re-resolve the same location on every send. Keyed by
// locationId; the value is the tenant row (or null = "no live tenant"),
// with a short TTL so a connect/disconnect self-heals within a minute.
// The cached row can contain the secret server token — this is a
// service-role, server-side cache in the send path (the token is already
// in memory there); it is never serialised out.
const SENDER_CACHE_TTL_MS = 60_000
const senderCache = new Map()

/** Test hook — clears the module-level sender cache between tests. */
export function _resetTenantEmailCache() {
  senderCache.clear()
}

/**
 * The GLOBAL DEFAULT sender: serverToken null (caller falls back to
 * getPostmarkToken() = POSTMARK_API_KEY), from = POSTMARK_FROM_EMAIL.
 * Read from env fresh each call so it always reflects the live config.
 * Pure.
 * @returns {{ serverToken: null, fromEmail: string|null, fromName: null }}
 */
export function globalDefaultSender() {
  return {
    serverToken: null,
    fromEmail: process.env.POSTMARK_FROM_EMAIL || null,
    fromName: null,
  }
}

/**
 * Build a sender from a LIVE tenant_email_domains row. Pure. Returns the
 * global default when the row is missing its server token (defensive —
 * a live row should always have one).
 * @param {{ postmark_server_token?: string, from_email?: string, from_name?: string }|null} row
 */
export function senderFromRow(row) {
  if (!row?.postmark_server_token) return globalDefaultSender()
  return {
    serverToken: row.postmark_server_token,
    fromEmail: row.from_email || process.env.POSTMARK_FROM_EMAIL || null,
    fromName: row.from_name || null,
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
 *   location → org → LIVE row  → that org's server token + verified From
 *   anything else / ANY error  → global default
 *
 * @param {object} db - service-role client (createServerClient())
 * @param {string|null|undefined} locationId
 * @returns {Promise<{ serverToken: string|null, fromEmail: string|null, fromName: string|null }>}
 */
export async function resolveEmailSender(db, locationId) {
  if (!db || !locationId) return globalDefaultSender()
  try {
    const cached = senderCache.get(locationId)
    let row
    if (cached && cached.expiresAt > Date.now()) {
      row = cached.row
    } else {
      row = await loadLiveRowForLocation(db, locationId)
      senderCache.set(locationId, { row, expiresAt: Date.now() + SENDER_CACHE_TTL_MS })
    }
    return senderFromRow(row)
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
 * True when ANY active location of the org is on a plan (tier or add-on)
 * whose resolved features include custom_email_domain. Plans are pinned
 * per LOCATION (mig 413) but the sending domain is per ORG, so an org
 * "has" the add-on if any of its locations does.
 *
 * FAIL CLOSED — this gates provisioning of PAID resources, so any error
 * (or no plan) resolves to false (feature off). Every org is unpinned
 * today → always false → the whole feature is unreachable.
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
      const plan = await getLocationPlan(db, loc.id)
      if (plan?.resolved?.features?.custom_email_domain === true) return true
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
    return { ...base, status: 'not_configured', sending_domain: null, from_email: null, from_name: null, dkim_verified: false, return_path_verified: false, records: [], last_error: null }
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
  }
}
