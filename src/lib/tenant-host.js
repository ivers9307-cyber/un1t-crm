// W1.L1 — the host a CUSTOMER-facing link is minted on, per tenant.
//
// Order: a custom tenant_domains row (location-scoped first, then whole-org)
// → the org's platform row <org.slug>.repset.ie → the same host synthesised
// from organizations.slug when the row is missing → the CRM host
// (getAppUrl()). NEVER throws past the floor: a link must always be minted,
// and crm.repset.ie serves every public path, so the floor is always safe.
//
// Staff-facing links (invites, rosters, approvals, QStash callbacks, Stripe
// Connect returns for staff) keep getAppUrl(): the CRM lives on the CRM host.
import { getAppUrl } from './app-url'

export const PLATFORM_HOST_SUFFIX = 'repset.ie'

// Labels under repset.ie the PLATFORM itself uses (or may): www (the public
// marketing site), crm (the staff CRM), api (the member-app origin,
// app-url.js), mail / pm-bounces (Postmark), host / pay / app (reserved for
// platform surfaces), wildcard-probe (the DNS probe). An org slug that is
// one of these can never become <slug>.repset.ie: the admin organizations
// route refuses it before the org exists.
export const RESERVED_PLATFORM_LABELS = Object.freeze([
  'www', 'crm', 'api', 'mail', 'host', 'pay', 'app', 'pm-bounces', 'wildcard-probe',
])

/** Pure: a slug that would collide with a platform-owned host label. */
export function isReservedPlatformLabel(slug) {
  return RESERVED_PLATFORM_LABELS.includes(String(slug || '').toLowerCase())
}
const CACHE_TTL_MS = 60_000
const cache = new Map()

export function _resetTenantHostCache() { cache.clear() }

/** Pure. */
export function platformHostnameFor(orgSlug) {
  return `${orgSlug}.${PLATFORM_HOST_SUFFIX}`
}

/** Pure: pick the hostname from an org's active rows for one location. */
export function pickTenantHost(rows, locationId) {
  const list = Array.isArray(rows) ? rows : []
  const custom = list.filter((r) => r.source === 'custom')
  return (
    custom.find((r) => r.location_id && r.location_id === locationId)?.hostname ||
    custom.find((r) => !r.location_id)?.hostname ||
    list.find((r) => r.source === 'platform')?.hostname ||
    null
  )
}

async function loadHostForLocation(db, locationId) {
  const { data: loc, error: locErr } = await db.from('locations').select('organization_id').eq('id', locationId).maybeSingle()
  if (locErr || !loc?.organization_id) return null
  const { data: rows } = await db.from('tenant_domains')
    .select('hostname, source, location_id')
    .eq('organization_id', loc.organization_id).eq('active', true)
  const picked = pickTenantHost(rows, locationId)
  if (picked) return picked
  const { data: org } = await db.from('organizations').select('slug').eq('id', loc.organization_id).maybeSingle()
  return org?.slug ? platformHostnameFor(org.slug) : null
}

/**
 * @param {object|null} db service-role client
 * @param {string|null} locationId
 * @returns {Promise<string>} `https://<host>` with no trailing slash
 */
export async function resolveCustomerBaseUrl(db, locationId) {
  const floor = () => getAppUrl()
  if (!db || !locationId) return floor()
  try {
    const hit = cache.get(locationId)
    let host
    if (hit && hit.expiresAt > Date.now()) host = hit.host
    else {
      host = await loadHostForLocation(db, locationId)
      cache.set(locationId, { host, expiresAt: Date.now() + CACHE_TTL_MS })
    }
    return host ? `https://${host}` : floor()
  } catch {
    return floor()
  }
}
