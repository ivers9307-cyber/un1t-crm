// W1.S1c — the ORGANISATION brand the host portal and the host emails speak
// for. An event host (Pride Training Club, say) is a third party that runs
// events THROUGH a gym: "submit it to <gym> for review", "ask <gym> to verify
// your sending domain", the portal's wordmark. That gym is the host's
// organisation: event_hosts.organization_id (NOT NULL, mig 381), which is
// also the organisation of the host's anchor location (ensureAnchorLocation
// inserts the anchor with host.organization_id). The anchor location itself
// is never the brand source: its name is the "<host> (host events)" label,
// so getLocationBranding on it would fall through to the HOST's own name for
// an org with no org_settings row.
//
// Two names, per W1.B1:
//   name       getOrgBrandName: org_settings.company_name → the org's master
//              location name → its earliest active location name. Sentences
//              ("contact UN1T Dublin").
//   shortName  org_settings.short_name (mig 715) when set, else `name`. The
//              wordmark (portal header, email header, "<host> × <brand>"),
//              so UN1T's portal keeps its bare "UN1T" mark.
// Both floor on PLATFORM_NAME, never a literal gym: an unresolvable org is
// one only the platform can help with. Never throws.
//
// Cached per organisation for HOST_ORG_BRAND_CACHE_TTL_MS: every portal page
// renders the header, so an uncached walk would cost ≤5 reads per click. An
// unresolved brand is NOT cached, so a read blip does not pin the platform
// name for five minutes; nor is a brand read while the org_settings
// short_name read FAILED, so a blip does not pin the long name in the
// wordmark either (the next render retries).

import { createServerClient } from './supabase'
import { PLATFORM_NAME } from './brand-name'
import { getOrgBrandName } from './location-branding'
import { resolveTenantOrgId } from './tenant-domains-edge'

export const HOST_ORG_BRAND_CACHE_TTL_MS = 5 * 60 * 1000

// Organisations are a handful of rows; the cap only bounds a pathological
// key space.
const MAX_CACHED_ORGS = 256
let cache = new Map()

const FLOOR = Object.freeze({ name: PLATFORM_NAME, shortName: PLATFORM_NAME })

// Test hook — the module-level cache would otherwise leak between tests.
export function _resetHostOrgBrandCache() {
  cache = new Map()
}

// { value, error }: an empty value with error=false is "no short name set";
// with error=true it is "unknown", and the caller must not cache it.
async function readShortName(db, organizationId) {
  try {
    const { data, error } = await db
      .from('org_settings')
      .select('short_name')
      .eq('organization_id', organizationId)
      .limit(1)
    if (error) return { value: '', error: true }
    return { value: String((data && data[0]?.short_name) || '').trim(), error: false }
  } catch {
    return { value: '', error: true }
  }
}

/**
 * The organisation's brand names for host-facing copy.
 * @param {object|null} db  a supabase-js client (service role)
 * @param {string|null} organizationId
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<{ name: string, shortName: string }>} never empty
 */
export async function resolveOrgBrand(db, organizationId, { nowMs = Date.now() } = {}) {
  if (!db || !organizationId) return FLOOR
  const hit = cache.get(organizationId)
  if (hit && nowMs - hit.at < HOST_ORG_BRAND_CACHE_TTL_MS) return hit.brand
  let name = ''
  let short = { value: '', error: true }
  try {
    ;[name, short] = await Promise.all([getOrgBrandName(db, organizationId), readShortName(db, organizationId)])
    name = String(name || '').trim()
  } catch {
    return FLOOR
  }
  const shortName = short.value
  if (!name && !shortName) return FLOOR
  const brand = Object.freeze({ name: name || shortName, shortName: shortName || name })
  if (!short.error) {
    if (cache.size >= MAX_CACHED_ORGS) cache.clear()
    cache.set(organizationId, { brand, at: nowMs })
  }
  return brand
}

/**
 * The brand of the organisation a host belongs to.
 * @param {object|null} db
 * @param {{ organization_id?: string|null }|null} host  an event_hosts row (or the portal session's host)
 * @returns {Promise<{ name: string, shortName: string }>}
 */
export function resolveHostOrgBrand(db, host) {
  return resolveOrgBrand(db, host?.organization_id || null)
}

/**
 * Pre-auth host pages (/host/login, /host/set-password, /host-connect): no
 * session yet, so the request's hostname is the only input. The host maps to
 * an organisation through W1.L4's resolveTenantOrgId (host.un1tdublin.com and
 * <slug>.repset.ie) — the org id only, not resolveHostBrand's logo/favicon
 * walk; the CRM host and an unmapped host have none and read the platform
 * name.
 * @param {string|null} requestHost  the raw Host header
 * @param {{ db?: object|null }} [opts]
 * @returns {Promise<{ name: string, shortName: string }>}
 */
export async function resolveRequestHostOrgBrand(requestHost, { db = null } = {}) {
  let client = db
  try {
    client = db || createServerClient()
  } catch {
    return FLOOR
  }
  let orgId = null
  try {
    orgId = await resolveTenantOrgId(requestHost || '', { db: client })
  } catch {
    return FLOOR
  }
  return resolveOrgBrand(client, orgId)
}
