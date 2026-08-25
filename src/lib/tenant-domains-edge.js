// SAAS-8 — DB tier of the multi-brand hostname registry (mig 415).
//
// src/lib/brands.js is the in-code FIRST tier and the guaranteed
// fallback: the three live hostnames resolve there and never reach
// this module. This module answers for everything the registry
// misses — the proxy consults it so a NEW tenant's domain needs no
// code deploy: point DNS at the deployment, insert a tenant_domains
// row, done.
//
// Fail-safe contract (load-bearing — the proxy runs on EVERY
// request): any miss, error, or slow/down/empty DB resolves to null,
// which the proxy treats exactly like an unknown hostname today —
// fall through to the CRM auth gate. A DB outage therefore cannot
// change the behaviour of any hostname that worked before this tier
// existed.
//
// Caching: a module-level TTL cache (~5 min, same pattern as
// default-favicon.js from SAAS-7) holds ALL active rows; per-request
// cost is an in-memory scan and the fetch happens at most once per
// TTL window per isolate. Failures are cached too — a down DB costs
// one attempt per window, not one per request.
//
// Runtime: imported by src/proxy.js (Edge). Only @supabase/ssr and
// the pure in-code ./brands.js module may be imported here — the
// ssr client is fetch-based and Edge-safe (same shape as the
// proxy's SAAS-3 api_keys lookup); brands.js is plain JS the proxy
// already runs on Edge. No node: imports, no zod (write-time
// validation lives in the admin routes; this read side
// re-normalises defensively instead).
//
// SAAS-6/7 HANDOFF SEAM: welcome-front-page.js (org chooser) and
// default-favicon.js resolve "whose front page / whose favicon" —
// they should thread the request host in and call
// resolveTenantOrgId(host): a mapped host renders that org's
// surface; null keeps their existing slug / first-row fallback
// byte-identical (un1tdublin.com has no row here by design).

import { createServerClient } from '@supabase/ssr'
import { getCrmHostnames } from './brands.js'

export const TENANT_DOMAINS_CACHE_TTL_MS = 5 * 60 * 1000 // domain churn is rare

// Defaults for a row whose brand config is {} (the column default):
// the "marketing chooser domain" shape. Root "/" and disallowed
// paths rewrite to /welcome IN THE PROXY — DB brands cannot rely on
// the build-baked next.config host rewrites, and the proxy's brand
// block already rewrites in-proxy for in-code brands, so DB brands
// ride the same code path. The allowlist mirrors un1t-marketing
// minus its UN1T-specific pretty paths; every entry is already
// public on the CRM hostname, so the default exposes nothing new.
export const DB_BRAND_DEFAULTS = Object.freeze({
  // '/privacy' (SAAS4-C2): startsWith-matched, so it also covers
  // /privacy/members — the tenant-aware notice that renders the
  // tenant's own legal entity once configured (tenant-privacy.js).
  // '/legal/' (SAAS4-C4): the public subprocessor register — tenant
  // privacy notices reference it.
  // '/account-deletion' (PUBPATH.1): this is the FOURTH public-path
  // allowlist, and it is the one the recurring "public page isn't public"
  // defect hides in — it sits one file away from brands.js and reads like
  // documentation rather than routing. '/privacy' above is startsWith-
  // matched and therefore already serves /privacy AND /privacy/members on a
  // tenant domain; BOTH of those pages link to /account-deletion with a
  // host-relative href (src/app/privacy/page.js, .../members/page.js), so
  // without this entry the tenant's own privacy notice promises a deletion
  // page and the fallback hands the reader the studio chooser instead.
  // Nothing tenant-specific is behind it (static copy naming an email
  // address), so it exposes nothing new — same argument as /privacy.
  // '/event-pay/' (AUDIT-13.B): the PAID LEG of the '/event/' flow already
  // allowed above — the exact gap PUBPATH.1 closed on the un1t-marketing
  // brand, still open here. RaceSignupWidget sends every paid signup to a
  // HOST-RELATIVE /event-pay/<id>, so on a tenant domain the registration
  // was taken and the payer was rewritten to /welcome, unpaid. Allowlist
  // the FLOW, not the entry page. LATENT (zero rows), which is precisely
  // why it needs a test rather than an operator noticing.
  //
  // Deliberately NOT here: '/race/' + '/race-pay/', next.config.js's
  // legacy aliases for the pair above. Those exist to keep externally
  // shared UN1T links alive, and they are on the CRM + marketing hosts
  // for that reason; a tenant domain is newer than the E3 rename, so no
  // legacy /race link for one can exist. Least privilege — add them to a
  // tenant's own brand override if that ever stops being true.
  // LATENT, not live: tenant_domains has zero rows today.
  allowedPaths: Object.freeze(['/welcome', '/book/', '/event/', '/event-pay/', '/privacy', '/legal/', '/account-deletion', '/api/public/', '/api/webhooks/']),
  rootHandler: 'rewrite',
  rootRewriteTo: '/welcome',
  fallbackHandler: 'rewrite',
  fallbackRewriteTo: '/welcome',
})

let cache = { rows: null, at: 0 }

// Test hook — the module-level cache would otherwise leak between tests.
export function _resetTenantDomainsCache() {
  cache = { rows: null, at: 0 }
}

// The CRM's own hostnames never have rows by design — skip even the
// cache consult for them so NO CRM host ever pays this tier, and a
// mistakenly-created row can never brand-gate the staff CRM on any
// of its domains. REPSET-P6: SET-valued — {crm.un1tdublin.com,
// crm.repset.ie} plus the NEXT_PUBLIC_APP_URL host (previews); see
// getCrmHostnames() in brands.js. Resilient to an unset/malformed
// env — the static set still guards.
function isCrmHostname(hostKey) {
  return getCrmHostnames().includes(hostKey)
}

function makeEdgeClient() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { cookies: { getAll: () => [], setAll: () => {} } }
  )
}

/**
 * Load (or serve from cache) the active tenant_domains rows.
 * Never throws; every failure path caches [] so the outcome — and
 * the cost — of a bad window is settled by one attempt.
 */
async function loadRows(db, nowMs) {
  if (cache.rows && nowMs - cache.at < TENANT_DOMAINS_CACHE_TTL_MS) return cache.rows
  let rows = []
  try {
    const client = db || makeEdgeClient()
    if (client) {
      const { data, error } = await client
        .from('tenant_domains')
        .select('id, hostname, organization_id, location_id, brand')
        .eq('active', true)
      if (!error && Array.isArray(data)) rows = data
    }
  } catch {
    // Fail-safe: cache the empty set — unknown hosts fall through to
    // the CRM auth gate exactly as they did before this tier existed.
  }
  cache = { rows, at: nowMs }
  return rows
}

// Read-side normalisation of the brand jsonb. The admin routes
// validate on write (tenantDomainBrandConfigSchema), but rows can
// predate schema changes or be written by hand — never let a bad
// value produce a brand the proxy's handler switch doesn't cover.
function normalizeHandler(value, fallback) {
  return value === 'reject' || value === 'rewrite' ? value : fallback
}

function normalizePath(value, fallback) {
  return typeof value === 'string' && value.startsWith('/') ? value : fallback
}

function brandFromRow(row) {
  const cfg = row.brand && typeof row.brand === 'object' && !Array.isArray(row.brand) ? row.brand : {}
  // An explicitly-present allowedPaths array is honoured even when
  // empty (a deliberate lock-down); an absent key gets the defaults.
  const allowedPaths = Array.isArray(cfg.allowedPaths)
    ? cfg.allowedPaths.filter((p) => typeof p === 'string' && p.startsWith('/'))
    : [...DB_BRAND_DEFAULTS.allowedPaths]
  return {
    // Same shape resolveBrand() returns, PLUS organizationId — the
    // tenant linkage the in-code registry never had.
    id: `tenant:${row.hostname}`,
    description: typeof cfg.description === 'string' && cfg.description
      ? cfg.description
      : `Tenant domain (${row.hostname})`,
    hostnames: [row.hostname],
    allowedPaths,
    rootHandler: normalizeHandler(cfg.rootHandler, DB_BRAND_DEFAULTS.rootHandler),
    rootRewriteTo: normalizePath(cfg.rootRewriteTo, DB_BRAND_DEFAULTS.rootRewriteTo),
    fallbackHandler: normalizeHandler(cfg.fallbackHandler, DB_BRAND_DEFAULTS.fallbackHandler),
    fallbackRewriteTo: normalizePath(cfg.fallbackRewriteTo, DB_BRAND_DEFAULTS.fallbackRewriteTo),
    organizationId: row.organization_id,
    // OPTIONAL per-location scoping (mig 432). NULL = whole org = the
    // original behaviour; the proxy's rewrite targets are UNCHANGED
    // either way (still /welcome). A non-null value is consumed only by
    // the /welcome resolution (resolveTenantLocationId below →
    // publicWelcomePathForLocation) to redirect strays to that ONE
    // studio's page — so a whole-org row routes byte-identically.
    locationId: row.location_id || null,
  }
}

/**
 * Match a hostname against the active tenant_domains rows. Call
 * ONLY after resolveBrand() returned null — the in-code registry is
 * the authoritative first tier.
 *
 * Port suffixes are stripped and the host is lowercased before
 * matching (rows store lowercase; the in-code tier's case-sensitive
 * contract is unchanged because it runs first).
 *
 * @param {string} hostname  Raw value of the `Host` request header.
 * @param {{ db?: object, nowMs?: number }} [opts]  Injectable for tests.
 * @returns {Promise<object | null>}  Brand (resolveBrand shape + organizationId), or null.
 */
export async function resolveTenantDomainBrand(hostname, { db = null, nowMs = Date.now() } = {}) {
  if (!hostname || typeof hostname !== 'string') return null
  const hostKey = hostname.split(':')[0].toLowerCase()
  if (!hostKey || isCrmHostname(hostKey)) return null
  const rows = await loadRows(db, nowMs)
  const row = rows.find((r) => r.hostname === hostKey)
  return row ? brandFromRow(row) : null
}

/**
 * Hostname → organization_id, or null when unmapped. The SAAS-6/7
 * handoff seam (see header): welcome-front-page.js renders a mapped
 * host's org chooser and keeps its slug fallback on null;
 * default-favicon.js likewise. Shares the row cache above.
 *
 * @param {string} hostname
 * @param {{ db?: object, nowMs?: number }} [opts]
 * @returns {Promise<string | null>}
 */
export async function resolveTenantOrgId(hostname, opts = {}) {
  const brand = await resolveTenantDomainBrand(hostname, opts)
  return brand ? brand.organizationId : null
}

/**
 * Hostname → location_id, or null when the host is unmapped OR mapped
 * to a WHOLE-ORG row (location_id NULL). Sibling of resolveTenantOrgId,
 * threaded into the /welcome resolution (see src/app/welcome/page.js):
 * a non-null result redirects strays to that ONE studio's public
 * welcome page; null keeps the org chooser byte-identical. Shares the
 * row cache above. (mig 432)
 *
 * @param {string} hostname
 * @param {{ db?: object, nowMs?: number }} [opts]
 * @returns {Promise<string | null>}
 */
export async function resolveTenantLocationId(hostname, opts = {}) {
  const brand = await resolveTenantDomainBrand(hostname, opts)
  return brand ? (brand.locationId || null) : null
}
