// W1.L4 — THE per-host brand: the ONE cache behind the site name
// (default-site-name.js), the favicon (default-favicon.js) and the anonymous
// /api/public/branding branch (login + reset-password screens).
//
// A request host maps to an organisation through resolveTenantOrgId (the
// in-code brand tier first — un1tdublin.com and host.un1tdublin.com are UN1T
// Group's — then tenant_domains, which carries <slug>.repset.ie and any
// custom domain), and getOrgCustomerBranding walks that org's chain per
// field (org_settings → the earliest active location's company_settings in
// that org → the location name). The result is held here, keyed by the
// NORMALISED host, for HOST_BRAND_CACHE_TTL_MS, so a cold host costs one
// walk (≤4 reads) shared by every consumer, not one walk per consumer; a
// miss (CRM host, unmapped host) and a failure are cached too.
//
// Why one cache: the first cut kept a name cache and a favicon cache and
// walked the chain uncached on every branding request — up to 12 reads per
// cold host and 6 per login-screen load (review of #1997).
//
// Never throws. A host with no organisation is the EMPTY brand (orgId null):
// callers floor on the platform name / mark themselves.

import { createServerClient } from './supabase'
import { PLATFORM_NAME } from './brand-name'
import { normalizeHost } from './brands'
import { resolveTenantOrgId } from './tenant-domains-edge'
import { getLocationBranding, getOrgCustomerBranding } from './location-branding'

export const HOST_BRAND_CACHE_TTL_MS = 5 * 60 * 1000 // renames and re-uploads are rare

// The wildcard *.repset.ie means the key space is open (any label resolves
// to this deployment), so the map is bounded: past the cap it is cleared.
const MAX_CACHED_HOSTS = 256
let cache = new Map()

const EMPTY = Object.freeze({ orgId: null, companyName: '', logoUrl: null, faviconUrl: null })

// Test hook — the module-level cache would otherwise leak between tests.
export function _resetHostBrandCache() {
  cache = new Map()
}

/**
 * The brand of the request host's organisation, cached per host.
 *
 * @param {{ host?: string|null, db?: object|null, nowMs?: number }} [opts]
 *   host: the raw `Host` header — `(await headers()).get('host')` in a layout.
 *   db: injected (tests) or null for the service-role client.
 * @returns {Promise<{ orgId: string|null, companyName: string, logoUrl: string|null, faviconUrl: string|null }>}
 */
export async function resolveHostBrand({ host = '', db = null, nowMs = Date.now() } = {}) {
  const key = normalizeHost(host)
  const hit = cache.get(key)
  if (hit && nowMs - hit.at < HOST_BRAND_CACHE_TTL_MS) return hit.brand
  let brand = EMPTY
  try {
    // One client for both reads: the injected one, else the service-role
    // client (so the tenant_domains tier never opens a second connection
    // here, and a test that mocks @/lib/supabase sees every read).
    const client = db || createServerClient()
    const orgId = await resolveTenantOrgId(key, { db: client })
    if (orgId) {
      const b = await getOrgCustomerBranding(client, orgId)
      brand = Object.freeze({
        orgId,
        // A whitespace-only name would render an empty tab title.
        companyName: String(b.companyName || '').trim(),
        logoUrl: b.logoUrl || null,
        faviconUrl: b.faviconUrl || null,
      })
    }
  } catch {
    brand = EMPTY
  }
  if (cache.size >= MAX_CACHED_HOSTS) cache.clear()
  cache.set(key, { brand, at: nowMs })
  return brand
}

// `locations.id` is a UUID. Postgres-permissive on purpose, matching
// `uuidLike` in schemas.js and UUID_RE in the unsubscribe API route.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Pure. */
export function isUuidLike(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * The brand NAME for a customer page that carries an optional location
 * scope in its URL (`/unsubscribe/<token>?l=<locationId>`, LOCCOMMS.4).
 *
 * The scope is honoured only when it is a UUID AND that location belongs to
 * the host's organisation, or the host has no organisation at all (a
 * CRM-host link, which is where every link was minted before W1.L3).
 * Anything else — a non-UUID, an unknown id, ANOTHER tenant's location —
 * reads the host's brand: `?l=` is caller-controlled, and the one thing
 * this module exists to guarantee is that no host ever renders another
 * tenant's name. A non-UUID costs no read at all.
 *
 * Never throws; floors on the host brand, then the platform name.
 *
 * @param {{ host?: string|null, locationId?: string|null, db?: object|null, nowMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function resolveScopedBrandName({ host = '', locationId = null, db = null, nowMs = Date.now() } = {}) {
  let client = db
  try { client = db || createServerClient() } catch { client = null }
  const hostBrand = await resolveHostBrand({ host, db: client, nowMs })
  const floor = hostBrand.companyName || PLATFORM_NAME
  if (!isUuidLike(locationId) || !client) return floor
  try {
    const { data, error } = await client
      .from('locations')
      .select('organization_id')
      .eq('id', locationId)
      .limit(1)
    const loc = (!error && data && data[0]) || null
    if (!loc) return floor
    if (hostBrand.orgId && loc.organization_id !== hostBrand.orgId) return floor
    const name = String((await getLocationBranding(client, locationId)).companyName || '').trim()
    return name || floor
  } catch {
    return floor
  }
}
