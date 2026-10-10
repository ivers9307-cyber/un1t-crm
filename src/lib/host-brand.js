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
import { isPubliclyVisible } from './landing-page-visibility'

export const HOST_BRAND_CACHE_TTL_MS = 5 * 60 * 1000 // renames and re-uploads are rare

// The wildcard *.repset.ie means the key space is open (any label resolves
// to this deployment), so the map is bounded: past the cap it is cleared.
const MAX_CACHED_HOSTS = 256
let cache = new Map()

const EMPTY = Object.freeze({ orgId: null, companyName: '', logoUrl: null, faviconUrl: null })

// Test hook — the module-level cache would otherwise leak between tests.
export function _resetHostBrandCache() {
  cache = new Map()
  _resetScopedBrandCaches()
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

// ─────────────────────────────────────────────────────────────────────────
// W1.S1b — the per-LOCATION and per-ORGANISATION twins of resolveHostBrand.
//
// The public pages, widgets and TV boards W1.S1b sweeps know a location (a
// landing row, an event, a kiosk token) or an organisation, not just a host.
// They name the gym through these two, never through a fresh walk per
// request: the live TV board polls every few seconds and a landing page is
// anonymous traffic, so each answer is held for HOST_BRAND_CACHE_TTL_MS,
// bounded like the host cache. Only a RESOLVED brand is cached: a failed
// read (or an empty name, which is what getLocationBranding returns when its
// reads error) is returned uncached, so one DB blip never pins an unbranded
// board or footer for the whole TTL.
// Never throws; an unresolved brand is empty strings (callers word around an
// empty brand, they never print a literal).

const MAX_CACHED_KEYS = 256
let locationCache = new Map()
let orgCache = new Map()

const EMPTY_LOCATION = Object.freeze({ companyName: '', shortName: '', locationName: '' })
const EMPTY_ORG = Object.freeze({ orgId: null, companyName: '', shortName: '', legalName: '', studios: Object.freeze([]) })

function cachedRead(map, key, nowMs) {
  const hit = map.get(key)
  return hit && nowMs - hit.at < HOST_BRAND_CACHE_TTL_MS ? hit.value : undefined
}

function cachedWrite(map, key, value, nowMs) {
  if (map.size >= MAX_CACHED_KEYS) map.clear()
  map.set(key, { value, at: nowMs })
  return value
}

// Test hook — both twin caches.
export function _resetScopedBrandCaches() {
  locationCache = new Map()
  orgCache = new Map()
}

/**
 * One location's brand, cached per location id: getLocationBranding's chain
 * (company_settings → org_settings → locations.name).
 *
 * @param {{ locationId?: string|null, db?: object|null, nowMs?: number }} [opts]
 * @returns {Promise<{ companyName: string, shortName: string, locationName: string }>}
 *   companyName: the studio's configured brand ("UN1T Stillorgan").
 *   shortName:   the wordmark (org_settings.short_name, else companyName: "UN1T").
 *   locationName: locations.name.
 */
export async function resolveLocationBrand({ locationId = null, db = null, nowMs = Date.now() } = {}) {
  if (!locationId) return EMPTY_LOCATION
  const key = String(locationId)
  const hit = cachedRead(locationCache, key, nowMs)
  if (hit) return hit
  let value = EMPTY_LOCATION
  try {
    const b = await getLocationBranding(db || createServerClient(), key)
    value = Object.freeze({
      companyName: String(b.companyName || '').trim(),
      shortName: String(b.shortName || '').trim(),
      locationName: String(b.locationName || '').trim(),
    })
  } catch {
    value = EMPTY_LOCATION
  }
  // getLocationBranding swallows its own read errors and hands back an empty
  // name, so an empty name is indistinguishable from a failure: never cache it.
  if (!value.companyName) return value
  return cachedWrite(locationCache, key, value, nowMs)
}

/**
 * An organisation's site chrome for the public marketing pages, cached per
 * org: the brand (getOrgCustomerBranding's chain), the wordmark
 * (org_settings.short_name, else the brand), the legal holder for the
 * copyright line (legal_trading_name → legal_entity_name → the brand), and
 * the org's LIVE studio pages for the footer ("Studios": locations.name →
 * /welcome/<public_path>, oldest studio first). Never another org's studio.
 *
 * @param {{ orgId?: string|null, db?: object|null, nowMs?: number }} [opts]
 * @returns {Promise<{ orgId: string|null, companyName: string, shortName: string, legalName: string, studios: Array<{ name: string, href: string }> }>}
 */
export async function resolveOrgChrome({ orgId = null, db = null, nowMs = Date.now() } = {}) {
  if (!orgId) return EMPTY_ORG
  const key = String(orgId)
  const hit = cachedRead(orgCache, key, nowMs)
  if (hit) return hit
  let value = EMPTY_ORG
  // Any failed read (or no brand at all) returns what we have WITHOUT caching
  // it: a partial chrome (no legal holder, no studios) must not stick for the TTL.
  let failed = false
  try {
    const client = db || createServerClient()
    const brand = await getOrgCustomerBranding(client, key)
    const companyName = String(brand.companyName || '').trim()

    const { data: osRows, error: osErr } = await client
      .from('org_settings')
      .select('short_name, legal_trading_name, legal_entity_name')
      .eq('organization_id', key)
      .limit(1)
    const os = (!osErr && osRows && osRows[0]) || {}
    const trim = (v) => (typeof v === 'string' ? v.trim() : '')

    const { data: locRows, error: locErr } = await client
      .from('locations')
      .select('id, name')
      .eq('organization_id', key)
      .eq('active', true)
      .order('created_at')
      .limit(50)
    const locs = (!locErr && locRows) || []
    let studios = []
    let pageErr = null
    if (locs.length) {
      const { data: pageRows, error } = await client
        .from('landing_page_settings')
        .select('location_id, public_path, publish_state')
        .in('location_id', locs.map((l) => l.id))
      pageErr = error
      const byLocation = new Map(
        ((!pageErr && pageRows) || [])
          .filter((r) => r.public_path && isPubliclyVisible(r.publish_state))
          .map((r) => [r.location_id, r.public_path]),
      )
      studios = locs
        .filter((l) => byLocation.has(l.id) && trim(l.name))
        .map((l) => Object.freeze({ name: trim(l.name), href: `/welcome/${byLocation.get(l.id)}` }))
    }

    failed = Boolean(osErr || locErr || pageErr) || !companyName

    value = Object.freeze({
      orgId: key,
      companyName,
      shortName: trim(os.short_name) || companyName,
      legalName: trim(os.legal_trading_name) || trim(os.legal_entity_name) || companyName,
      studios: Object.freeze(studios),
    })
  } catch {
    value = EMPTY_ORG
    failed = true
  }
  if (failed) return value
  return cachedWrite(orgCache, key, value, nowMs)
}
