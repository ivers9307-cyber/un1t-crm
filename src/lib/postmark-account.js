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

import { getAppUrl } from '@/lib/app-url'

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
    const err = new Error(`Postmark account API error: ${json?.Message || `HTTP ${res.status}`}`)
    // Structured copies so a caller can branch on WHICH refusal it was
    // (isDomainAlreadyExistsError) without re-parsing the message. Neither
    // carries the token: both come off Postmark's response body.
    err.status = res.status
    err.postmarkErrorCode = json?.ErrorCode ?? null
    err.postmarkMessage = json?.Message || null
    throw err
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

/**
 * True when an account-API error is Postmark refusing POST /domains because a
 * domain of that name is already in the account ("Domain already exists.").
 * Domains are ACCOUNT resources and a name exists once per account, so this is
 * what a second registration of the same domain (or of the platform's own
 * domain) answers. Judged on Postmark's Message, falling back to the thrown
 * message. Pure.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isDomainAlreadyExistsError(e) {
  const text = String(e?.postmarkMessage || e?.message || '')
  return /domain already exists/i.test(text)
}

// GET /domains pages at most 500 per call (Postmark's cap for `count`).
const DOMAIN_LIST_PAGE = 500
// Guard against a misbehaving TotalCount: 100 pages = 50,000 domains.
const DOMAIN_LIST_MAX_PAGES = 100

/**
 * Find an account-level domain by name: GET /domains?count=&offset=, paged
 * until TotalCount is reached or a page comes back short. Names compare
 * case-insensitively. Returns the list entry ({ ID, Name, … }) or null.
 * @param {string} name
 * @returns {Promise<{ ID: number, Name: string }|null>}
 */
export async function findTenantDomainByName(name) {
  const wanted = String(name || '').trim().toLowerCase()
  if (!wanted) return null
  for (let page = 0; page < DOMAIN_LIST_MAX_PAGES; page++) {
    const offset = page * DOMAIN_LIST_PAGE
    const json = await accountRequest('GET', `/domains?count=${DOMAIN_LIST_PAGE}&offset=${offset}`)
    const domains = Array.isArray(json.Domains) ? json.Domains : []
    const hit = domains.find((d) => String(d?.Name || '').trim().toLowerCase() === wanted)
    if (hit) return hit
    const total = Number(json.TotalCount)
    if (domains.length < DOMAIN_LIST_PAGE) return null
    if (Number.isFinite(total) && offset + domains.length >= total) return null
  }
  return null
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

// ─────────────────────────────────────────────────────────────
// W1.E3 — SERVER-token calls: a tenant server is born with its streams
// and webhooks
// ─────────────────────────────────────────────────────────────
//
// A bare server (POST /servers above) has only the outbound + inbound
// streams and no webhooks: every campaign (MessageStream 'broadcast',
// postmark.js sendBatch) would be refused (Postmark ErrorCode 1235), and list
// health, bounce escalation and stats would read 0 for the tenant because no
// Open/Click/Delivery/Bounce/SpamComplaint/SubscriptionChange event ever
// reached /api/webhooks/postmark. Both helpers are idempotent (list first,
// create only what is missing) and authenticate with the SERVER token — the
// account token cannot manage a server's streams or hooks. The receiver
// (src/app/api/webhooks/postmark/route.js) authenticates on the
// X-Webhook-Token custom header, so a hook registered without it would 403
// on every event: the helper refuses to register one.

/** The six triggers the global CRM.UN1T server carries on both streams. */
export const WEBHOOK_TRIGGERS = Object.freeze({
  Open: { Enabled: true, PostFirstOpenOnly: false },
  Click: { Enabled: true },
  Delivery: { Enabled: true },
  Bounce: { Enabled: true, IncludeContent: false },
  SpamComplaint: { Enabled: true, IncludeContent: false },
  SubscriptionChange: { Enabled: true },
})

/** The streams the app sends on: transactional + campaigns. */
export const WEBHOOK_STREAMS = Object.freeze(['outbound', 'broadcast'])

const BROADCAST_STREAM = Object.freeze({
  ID: 'broadcast',
  Name: 'Broadcasts',
  MessageStreamType: 'Broadcasts',
  // The app runs its own unsubscribe (preference centre + consent_log);
  // Postmark's hosted unsubscribe would bypass consent_log.
  SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' },
})

// Same error contract as accountRequest: Postmark's Message or the HTTP
// status — NEVER the token.
async function serverRequest(serverToken, method, path, body) {
  if (!serverToken) throw new Error('Postmark server token missing.')
  let res
  try {
    res = await fetch(`${POSTMARK_ACCOUNT_API_URL}${path}`, {
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': serverToken,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch (e) {
    throw new Error(`Postmark server API unreachable: ${e?.message || 'network error'}`)
  }
  let json = null
  try {
    json = await res.json()
  } catch {
    // Non-JSON body — fall through to the status-based message.
  }
  if (!res.ok) {
    throw new Error(`Postmark server API error: ${json?.Message || `HTTP ${res.status}`}`)
  }
  return json || {}
}

/**
 * Ensure the server has the `broadcast` message stream (campaign sends put
 * MessageStream 'broadcast' on the wire). Idempotent.
 * @param {string} serverToken - the tenant server's token (SECRET; never logged)
 * @returns {Promise<{ created: boolean }>}
 */
export async function ensureTenantServerStreams(serverToken) {
  const list = await serverRequest(serverToken, 'GET', '/message-streams')
  const existing = (Array.isArray(list.MessageStreams) ? list.MessageStreams : []).map((s) => s?.ID)
  if (existing.includes(BROADCAST_STREAM.ID)) return { created: false }
  await serverRequest(serverToken, 'POST', '/message-streams', BROADCAST_STREAM)
  return { created: true }
}

/**
 * Ensure one six-trigger webhook per stream (outbound + broadcast) points at
 * this deployment's /api/webhooks/postmark, carrying the X-Webhook-Token
 * header the receiver checks. Idempotent: a hook on the same url + stream is
 * left alone (never edited — a rotated token is the operator's rotation
 * procedure, docs/architecture/INTEGRATIONS.md).
 * @param {string} serverToken
 * @returns {Promise<{ created: string[] }>} the streams a hook was created for
 */
export async function ensureTenantServerWebhooks(serverToken) {
  const token = process.env.POSTMARK_WEBHOOK_TOKEN
  if (!token) {
    // No silent fallback: a hook without the header 403s on every event.
    // (POSTMARK_WEBHOOK_TOKEN; the message reaches an org admin via
    // last_error, so it names no env var.)
    throw new Error('Webhook signing token is not configured on this deployment.')
  }
  const url = `${getAppUrl()}/api/webhooks/postmark`
  const list = await serverRequest(serverToken, 'GET', '/webhooks')
  const existing = Array.isArray(list.Webhooks) ? list.Webhooks : []
  const created = []
  for (const stream of WEBHOOK_STREAMS) {
    if (existing.some((w) => w?.Url === url && w?.MessageStream === stream)) continue
    await serverRequest(serverToken, 'POST', '/webhooks', {
      Url: url,
      MessageStream: stream,
      HttpHeaders: [{ Name: 'X-Webhook-Token', Value: token }],
      Triggers: WEBHOOK_TRIGGERS,
    })
    created.push(stream)
  }
  return { created }
}
