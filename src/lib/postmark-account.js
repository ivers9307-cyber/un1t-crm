// INTEG-B3 — Postmark ACCOUNT API client (server-per-tenant provisioning).
//
// Hits the ACCOUNT-level API (X-Postmark-Account-Token, env
// POSTMARK_ACCOUNT_TOKEN) — the same token src/lib/postmark-domains.js uses
// for the events host-domain feature, NOT the server token that
// src/lib/postmark.js sends with (POSTMARK_API_KEY). Servers, Domains and
// Sender Signatures are all ACCOUNT resources: a domain verified at the
// account level can be sent From by any server in the account, so a tenant
// org gets BOTH its own server (own streams/reputation/analytics) AND its
// own verified sending domain here.
//
// CRITICAL — this module only EVER runs at RUNTIME when an org owner drives
// the wizard. It is never exercised at build/test time: every test mocks
// fetch. Creating a server or a domain is a real, billable Postmark action.
//
// Error contract: non-2xx throws with Postmark's Message (or the HTTP
// status when the body is unparseable) — NEVER the token. Response-shaping
// helpers are pure and unit-tested against a mocked fetch.

const POSTMARK_ACCOUNT_API_URL = 'https://api.postmarkapp.com'

/**
 * True when POSTMARK_ACCOUNT_TOKEN is set. Routes call this to answer 503
 * cleanly instead of throwing a 500 when the account token is absent (e.g.
 * a preview deploy without the secret). Never touches the network.
 * @returns {boolean}
 */
export function isPostmarkAccountConfigured() {
  return !!process.env.POSTMARK_ACCOUNT_TOKEN
}

function getAccountToken() {
  const token = process.env.POSTMARK_ACCOUNT_TOKEN
  if (!token) {
    // No silent fallback (CLAUDE.md) — the server token cannot manage
    // servers/domains, so there is nothing safe to fall back to.
    throw new Error(
      'Postmark account token not configured. Set POSTMARK_ACCOUNT_TOKEN (the ' +
      'account-level token from Postmark → Account → API Tokens — the server ' +
      'token cannot create servers or domains).'
    )
  }
  return token
}

async function accountRequest(method, path, body) {
  const token = getAccountToken()
  let res
  try {
    res = await fetch(`${POSTMARK_ACCOUNT_API_URL}${path}`, {
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Account-Token': token,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch (e) {
    throw new Error(`Postmark account API unreachable: ${e?.message || 'network error'}`)
  }
  let json = null
  try {
    json = await res.json()
  } catch {
    // Non-JSON body (proxy error page, empty 204…) — fall through to the
    // status-based message below.
  }
  if (!res.ok) {
    throw new Error(`Postmark account API error: ${json?.Message || `HTTP ${res.status}`}`)
  }
  return json || {}
}

// ─────────────────────────────────────────────────────────────
// Pure response shapers (unit-tested)
// ─────────────────────────────────────────────────────────────

/**
 * Shape a Postmark /servers response: the new server's id and its FIRST
 * API token (the server token we store + send with). Postmark returns
 * ApiTokens as an array; the first element is the live server token.
 * @param {object|null} server
 * @returns {{ id: number|null, serverToken: string|null }}
 */
export function shapeServerResponse(server) {
  const tokens = Array.isArray(server?.ApiTokens) ? server.ApiTokens : []
  return {
    id: server?.ID ?? null,
    serverToken: tokens[0] || null,
  }
}

/**
 * Shape a Postmark /domains response into the fields we persist. DKIM is
 * reported as a PENDING host/value pair until verified
 * (DKIMPendingHost/DKIMPendingTextValue), then the active pair
 * (DKIMHost/DKIMTextValue) — prefer pending, fall back to active.
 * Return-Path is always ReturnPathDomain → CNAME → ReturnPathDomainCNAMEValue.
 * @param {object|null} domain
 */
export function shapeDomainResponse(domain) {
  return {
    id: domain?.ID ?? null,
    dkimPendingHost: domain?.DKIMPendingHost || domain?.DKIMHost || null,
    dkimPendingValue: domain?.DKIMPendingTextValue || domain?.DKIMTextValue || null,
    dkimVerified: !!domain?.DKIMVerified,
    returnPathDomain: domain?.ReturnPathDomain || null,
    returnPathCnameValue: domain?.ReturnPathDomainCNAMEValue || null,
    returnPathVerified: !!domain?.ReturnPathDomainVerified,
  }
}

/**
 * A domain is fully verified only when BOTH DKIM and Return-Path are. Pure.
 * @param {{ dkimVerified?: boolean, returnPathVerified?: boolean }|null} shaped
 * @returns {boolean}
 */
export function domainIsFullyVerified(shaped) {
  return !!(shaped?.dkimVerified && shaped?.returnPathVerified)
}

/**
 * Sanitize an operator-entered hostname to a bare, lowercase sending
 * domain: strip scheme/port/path, lowercase, keep [a-z0-9.-], trim edge
 * dots/dashes. Degenerate input → '' (caller decides the fallback). Pure.
 * @param {string|null|undefined} input
 * @returns {string}
 */
export function sanitizeSendingDomain(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/:].*$/, '')      // drop path / port
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/^[.-]+|[.-]+$/g, '')
}

// ─────────────────────────────────────────────────────────────
// Account API calls (each returns the SHAPED result)
// ─────────────────────────────────────────────────────────────

/**
 * POST /servers — create the org's dedicated Postmark server. Returns the
 * new server id + its first API token (the server token). The token is a
 * SECRET — the caller persists it on tenant_email_domains and never
 * exposes it.
 * @param {string} orgName - used to name the server in the Postmark UI
 * @returns {Promise<{ id: number|null, serverToken: string|null }>}
 */
export async function createTenantServer(orgName) {
  const name = String(orgName || 'tenant').slice(0, 60)
  const json = await accountRequest('POST', '/servers', {
    // Distinctive, greppable name in the Postmark account UI.
    Name: `un1t-tenant-${name}`,
    Color: 'Purple',
  })
  return shapeServerResponse(json)
}

/** POST /domains — register the org's sending domain. Returns the shaped DNS state. */
export async function createTenantDomain(name) {
  const json = await accountRequest('POST', '/domains', { Name: name })
  return shapeDomainResponse(json)
}

/** GET /domains/{id} — current domain details (verification booleans + DNS values). */
export async function getTenantDomain(id) {
  const json = await accountRequest('GET', `/domains/${id}`)
  return shapeDomainResponse(json)
}

/** PUT /domains/{id}/verifyDkim — ask Postmark to re-check the DKIM TXT record. */
export async function verifyTenantDomainDkim(id) {
  const json = await accountRequest('PUT', `/domains/${id}/verifyDkim`)
  return shapeDomainResponse(json)
}

/** PUT /domains/{id}/verifyReturnPath — ask Postmark to re-check the Return-Path CNAME. */
export async function verifyTenantReturnPath(id) {
  const json = await accountRequest('PUT', `/domains/${id}/verifyReturnPath`)
  return shapeDomainResponse(json)
}
