// CHROME.1 / W1.L4 — the SITE NAME for a request, resolved by its HOST.
//
// Two audiences read the <title> / OG site name this module produces:
//   • ~160 of the 188 pages in this app are the STAFF CRM and carry no
//     metadata of their own (the root layout labels them; staff layouts
//     then name the active studio, TABTITLE.1).
//   • the customer-facing subtrees (/book, /event, /event-pay, /host,
//     /host-connect, /reset-password, /account) declare their own metadata
//     through customerFacingMetadata() below.
//
// WHICH tenant's name? Since W1.L4 (SaaS Wave 1, decision 4): the REQUEST
// HOST's organisation. resolveTenantOrgId(host) answers for an in-code brand
// (un1tdublin.com → UN1T Group, brands.js) and for any tenant_domains row
// (<slug>.repset.ie, a custom domain); getOrgCustomerBranding then walks the
// brand chain for that org: org_settings.company_name → the earliest active
// location's company_settings.company_name in that org → the location's
// name. A CRM host (crm.repset.ie, crm.un1tdublin.com) and any unmapped host
// have no organisation, and read the PLATFORM name: the product running
// there IS Repset, and no gym is in the picture.
//
// Before W1.L4 both resolvers took the FIRST configured company_settings
// row in the ESTATE ordered by location_id, so every tenant's customers —
// and the CRM itself — read whichever gym sorted first. That is the
// cross-tenant hole this module closes; brand-chrome.test.js pins that a
// second tenant's row can never change another tenant's rendered brand.
//
// resolveDefaultSiteName (root layout) and resolveGymSiteName (customer
// layouts) are the SAME resolver since W1.L4 — one chain, one floor. Both
// names stay exported because the two audiences are still separate seams
// in the layouts (brand-chrome.test.js pins which one each subtree uses).
//
// PERFORMANCE: runs in generateMetadata on every request, so the answer is
// held in a module-level TTL cache KEYED BY HOST (one DB round-trip set per
// host per window per lambda); the tenant_domains rows behind
// resolveTenantOrgId have their own 5-min cache. Never throws.

import { createServerClient } from './supabase'
import { PLATFORM_NAME } from './brand-name'
import { resolveTenantOrgId } from './tenant-domains-edge'
import { getOrgCustomerBranding } from './location-branding'

// The platform's own name. Used when the host has NO organisation — at that
// point there is no gym identity to show, and the product this deployment
// is running IS Repset. One source (W1.B1): shared/brand-name.js, so the
// phone, champ-app and this chrome never drift.
export const PLATFORM_SITE_NAME = PLATFORM_NAME

export const SITE_NAME_CACHE_TTL_MS = 5 * 60 * 1000 // renames are rare

// Host → { name, at }. The wildcard *.repset.ie means the key space is open
// (any label resolves to this deployment), so the map is bounded: past the
// cap it is cleared rather than grown.
const MAX_CACHED_HOSTS = 256
let cache = new Map()

// Test hook — the module-level cache would otherwise leak between tests.
export function _resetDefaultSiteNameCache() {
  cache = new Map()
}

/** Port stripped, lowercased; '' for no host. Shared with the favicon cache. */
export function hostCacheKey(host) {
  return String(host || '').split(':')[0].trim().toLowerCase()
}

/**
 * The host's organisation brand name, or null when the host has no
 * organisation or the organisation has no resolvable name. Never throws.
 *
 * @param {string} host
 * @param {object|null} db  injected (tests) or null for the service-role client
 * @returns {Promise<string|null>}
 */
async function readBrandNameForHost(host, db) {
  try {
    const orgId = await resolveTenantOrgId(host, { db })
    if (!orgId) return null
    const client = db || createServerClient()
    const { companyName } = await getOrgCustomerBranding(client, orgId)
    const name = String(companyName || '').trim()
    // A whitespace-only name would render an empty tab title.
    return name || null
  } catch {
    /* treat an unreadable brand as "no organisation name" */
  }
  return null
}

/**
 * The site name for a request host. Tenant host → the organisation's brand;
 * CRM / unmapped host → PLATFORM_SITE_NAME. Never throws; the miss and the
 * failure are cached too, so a down DB costs one attempt per host per TTL.
 *
 * @param {{ host?: string|null, db?: object, nowMs?: number }} [opts]
 *   host: the raw `Host` header — `(await headers()).get('host')` in a layout.
 * @returns {Promise<string>}
 */
export async function resolveSiteNameForHost({ host = '', db = null, nowMs = Date.now() } = {}) {
  const key = hostCacheKey(host)
  const hit = cache.get(key)
  if (hit && nowMs - hit.at < SITE_NAME_CACHE_TTL_MS) return hit.name
  const name = (await readBrandNameForHost(key, db)) || PLATFORM_SITE_NAME
  if (cache.size >= MAX_CACHED_HOSTS) cache.clear()
  cache.set(key, { name, at: nowMs })
  return name
}

/**
 * The root layout's resolver — the staff CRM and every page without its own
 * metadata. Same chain as resolveGymSiteName since W1.L4; kept as its own
 * name so the two audiences remain separate seams in the layouts.
 */
export const resolveDefaultSiteName = resolveSiteNameForHost

/**
 * The customer-facing resolver — booking pages, event payment, the host
 * portal, password reset, the member account pages, and the OG site name
 * on the public event / studio pages.
 */
export const resolveGymSiteName = resolveSiteNameForHost

/**
 * Metadata for a customer-facing route subtree. Every customer/partner page
 * that inherited the root layout's metadata imports this from its own
 * layout and threads the request host in:
 *   customerFacingMetadata({ host: (await headers()).get('host') })
 * so the gym's identity — the right gym's — labels the tab and the link
 * preview.
 *
 * NO `description`: the root layout used to carry a hard-coded UN1T marketing
 * tagline, which was neither operator-editable nor true for another tenant.
 * Echoing the site name back as the description (a one-word preview on a
 * shared link) is worse than omitting it. company_settings has no tagline
 * column; per CLAUDE.md that is where an editable one belongs —
 * `ALTER TABLE company_settings ADD COLUMN meta_description text` plus a
 * field on /settings → BrandingSettings — and this is the single place that
 * would read it. NOT applied here: this branch takes no migrations.
 *
 * @param {{ host?: string|null, db?: object, nowMs?: number }} [opts]
 * @returns {Promise<object>} a Next.js Metadata object
 */
export async function customerFacingMetadata(opts = {}) {
  const siteName = await resolveGymSiteName(opts)
  return {
    title: siteName,
    openGraph: { title: siteName, siteName, type: 'website' },
  }
}
