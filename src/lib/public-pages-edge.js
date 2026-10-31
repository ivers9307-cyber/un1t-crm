// PAGES.1 — which public pages exist, as the proxy sees them.
// Every public marketing page is a `landing_pages` row (mig 792). A public
// path used to be hand-listed in FOUR places (proxy publicPaths, AppShell
// PUBLIC_PATHS, the un1t-marketing allowedPaths, DB_BRAND_DEFAULTS), so a new
// page needed a deploy. The proxy now asks THIS module for the organisation's
// page slugs and admits `/<slug>` and `/<slug>/…`; the in-code lists stay as
// the guaranteed fallback and are not trimmed here.
//
// Edge-safe on purpose: the proxy (Next middleware, edge runtime) imports it,
// so it may import only edge-safe modules (brands, tenant-domains-edge, the
// pure page-slug rules) and
// never @/lib/auth, @/lib/permissions or a Node built-in.
//
// Fail-safe contract (the proxy runs on EVERY request): a slow, down or
// erroring DB answers the in-code fallback for the organisation (UN1T Group:
// the five campaign slugs that were code routes before this module existed,
// and its two studio pages; any other org: none) and CACHES that answer for
// the TTL, so an outage costs one attempt a minute, never one per request,
// and /trial and /stillorgan stay public through it.
//
// Every page kind is admitted (PR3): a studio page (/stillorgan,
// /hatch-street, and /<slug>/events, /<slug>/status under it) is served by the
// one [slug] route like a campaign page. AppShellServer also hands this list
// to AppShell, whose client gate needs it on a soft navigation, when the
// proxy's x-public-page header (read once by the root layout) is stale.
//
// The design is docs/superpowers/specs/2026-10-30-landing-pages-editor-design.md.

import { resolveBrand, UN1T_GROUP_ORG_ID, isFrameworkAsset } from '@/lib/brands'
import { resolveTenantOrgId, makeEdgeClient } from '@/lib/tenant-domains-edge'
import { publicPageSegmentMatches } from '@/lib/page-slug'

export const PUBLIC_PAGES_CACHE_TTL_MS = 60_000

// The slugs UN1T Group serves as pages: the campaign slugs that were code
// routes before they were database rows, and its two studio pages.
export const PUBLIC_PAGE_SLUGS_FALLBACK = Object.freeze({
  [UN1T_GROUP_ORG_ID]: Object.freeze(['trial', '50plus', 'corp', 'start', 'free-class', 'stillorgan', 'hatch-street']),
})

// A page is public once it is live, announced as coming soon, or retired (a
// retired page answers its own "no longer available" screen, not a login wall).
const PUBLIC_PUBLISH_STATES = ['live', 'coming_soon', 'retired']

// { [orgId]: { slugs, at } }
let cache = {}

export function _resetPublicPagesCache() {
  cache = {}
}

function fallbackFor(orgId) {
  return [...(PUBLIC_PAGE_SLUGS_FALLBACK[orgId] || [])]
}

/**
 * The page slugs that are public for an organisation. Never throws.
 *
 * @param {string | null} orgId
 * @param {{ db?: object, nowMs?: number }} [opts]  Injectable for tests.
 * @returns {Promise<string[]>}
 */
export async function listPublicPageSlugs(orgId, { db = null, nowMs = Date.now() } = {}) {
  if (!orgId || typeof orgId !== 'string') return []
  const hit = cache[orgId]
  if (hit && nowMs - hit.at < PUBLIC_PAGES_CACHE_TTL_MS) return hit.slugs
  let slugs
  try {
    const client = db || makeEdgeClient()
    if (!client) throw new Error('no edge client')
    const { data, error } = await client
      .from('landing_pages')
      .select('slug')
      .eq('organization_id', orgId)
      .in('publish_state', PUBLIC_PUBLISH_STATES)
    if (error || !Array.isArray(data)) throw new Error('landing_pages read failed')
    slugs = data.map((r) => r.slug).filter((s) => typeof s === 'string' && s)
  } catch {
    // Fail-safe: the in-code answer, cached for the window.
    slugs = fallbackFor(orgId)
  }
  cache[orgId] = { slugs, at: nowMs }
  return slugs
}

/**
 * True when the path's FIRST segment is one of the slugs (and not a framework
 * asset): the segment rule is publicPageSegmentMatches (page-slug.js), shared
 * with AppShell, so `/trialx` is not `/trial` and a reserved app segment
 * (RESERVED_PAGE_SLUGS) is never a page even when the DB list names it.
 */
export function isPublicPagePath(pathname, slugs) {
  if (typeof pathname !== 'string' || isFrameworkAsset(pathname)) return false
  return publicPageSegmentMatches(pathname, slugs)
}

// The request header AppShell reads (via AppShellServer) so its client-side
// auth wall renders a database-driven public page bare. The proxy sets it on a
// request it admitted and strips any incoming copy first (a client cannot
// forge it), so its presence means "the proxy admitted this path".
export const PUBLIC_PAGE_HEADER = 'x-public-page'

export function withPublicPageHeader(headers) {
  const next = new Headers(headers)
  next.set(PUBLIC_PAGE_HEADER, '1')
  return next
}

/**
 * Host → organisation id. An in-code brand that carries an `organizationId`
 * (un1tdublin.com) wins; else a `tenant_domains` row; else UN1T Group, which is
 * also the answer for the CRM host and for a missing hostname.
 */
export async function publicOrgIdForHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return UN1T_GROUP_ORG_ID
  const brand = resolveBrand(hostname)
  if (brand?.organizationId) return brand.organizationId
  const tenantOrgId = await resolveTenantOrgId(hostname)
  return tenantOrgId || UN1T_GROUP_ORG_ID
}
