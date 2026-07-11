// HOST-EMAIL.2 — Postmark Domains API wrappers (sender-domain provisioning
// for event hosts).
//
// These hit the ACCOUNT-level API (X-Postmark-Account-Token, env
// POSTMARK_ACCOUNT_TOKEN) — NOT the server token that src/lib/postmark.js
// sends with (POSTMARK_API_KEY). Domains are an account resource: one
// UN1T-allocated subdomain per host (<label>.mail.un1tdublin.com), whose
// DKIM + Return-Path records the operator adds to the un1tdublin.com DNS
// zone. Hosts cannot send until verified (event_hosts.sender_domain_verified);
// un-verifying is the per-host kill switch.
//
// Error contract: non-2xx throws with Postmark's Message (or the HTTP
// status when the body is unparseable) — never the token.

const POSTMARK_ACCOUNT_API_URL = 'https://api.postmarkapp.com'

function getAccountToken() {
  const token = process.env.POSTMARK_ACCOUNT_TOKEN
  if (!token) {
    throw new Error(
      'Postmark account token not configured. Set POSTMARK_ACCOUNT_TOKEN (the ' +
      'account-level token from Postmark → Account → API Tokens — the server ' +
      'token cannot manage domains).'
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
    throw new Error(`Postmark domains API unreachable: ${e?.message || 'network error'}`)
  }
  let json = null
  try {
    json = await res.json()
  } catch {
    // Non-JSON body (proxy error page, empty 204…) — fall through to the
    // status-based message below.
  }
  if (!res.ok) {
    throw new Error(`Postmark domains API error: ${json?.Message || `HTTP ${res.status}`}`)
  }
  return json || {}
}

/** POST /domains — register a new sending domain. Returns Postmark's domain details. */
export function createDomain(name) {
  return accountRequest('POST', '/domains', { Name: name })
}

/** GET /domains/{id} — current domain details (verification flags + DNS values). */
export function getDomain(id) {
  return accountRequest('GET', `/domains/${id}`)
}

/** PUT /domains/{id}/verifyDkim — ask Postmark to re-check the DKIM TXT record. */
export function verifyDkim(id) {
  return accountRequest('PUT', `/domains/${id}/verifyDkim`)
}

/** PUT /domains/{id}/verifyReturnPath — ask Postmark to re-check the Return-Path CNAME. */
export function verifyReturnPath(id) {
  return accountRequest('PUT', `/domains/${id}/verifyReturnPath`)
}

/**
 * Sanitize an operator-entered subdomain label to [a-z0-9-]: lowercased,
 * non-alphanumeric runs collapsed to single dashes, edge dashes trimmed.
 * Pure. Degenerate input → '' (caller decides the fallback).
 * @param {string|null|undefined} input
 * @returns {string}
 */
export function sanitizeDomainLabel(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The DNS records the operator must add, mapped defensively from a Postmark
 * domain-details response. DKIM: Postmark reports a PENDING host/value pair
 * until the key is verified (DKIMPendingHost/DKIMPendingTextValue), then the
 * active pair (DKIMHost/DKIMTextValue) — prefer pending, fall back to active.
 * Return-Path is always ReturnPathDomain → CNAME → ReturnPathDomainCNAMEValue.
 * Entries missing a name or value are omitted rather than rendered blank.
 * Pure.
 * @param {object|null} domain  Postmark domain-details response
 * @returns {Array<{purpose:string, type:string, name:string, value:string}>}
 */
export function dnsRecordsFrom(domain) {
  const records = []
  const dkimName = domain?.DKIMPendingHost || domain?.DKIMHost || ''
  const dkimValue = domain?.DKIMPendingTextValue || domain?.DKIMTextValue || ''
  if (dkimName && dkimValue) {
    records.push({ purpose: 'DKIM', type: 'TXT', name: dkimName, value: dkimValue })
  }
  const rpName = domain?.ReturnPathDomain || ''
  const rpValue = domain?.ReturnPathDomainCNAMEValue || ''
  if (rpName && rpValue) {
    records.push({ purpose: 'Return-Path', type: 'CNAME', name: rpName, value: rpValue })
  }
  return records
}

/**
 * A host may send only when BOTH DKIM and Return-Path are verified. Pure.
 * @param {object|null} domain  Postmark domain-details response
 * @returns {boolean}
 */
export function domainIsFullyVerified(domain) {
  return !!(domain?.DKIMVerified && domain?.ReturnPathDomainVerified)
}
