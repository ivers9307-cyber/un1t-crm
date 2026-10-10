// SAAS-7 / W1.L4 — the favicon for a request, resolved by its HOST.
//
// The root layout used to hardcode a public-storage URL containing the
// seeded Stillorgan UUID — a tenant hardcode in the one file every page
// renders through. SAAS-7 made it operator-editable (/settings →
// BrandingSettings writes company_settings.favicon_url via
// /api/settings/branding/upload) but resolved "the first configured row in
// the estate", so one tenant's icon labelled every tenant's tabs — and the
// CRM's. W1.L4 (SaaS Wave 1, decision 4) resolves by the REQUEST HOST's
// organisation instead, the same way default-site-name.js resolves the
// name: resolveTenantOrgId(host) → getOrgCustomerBranding(org).faviconUrl
// (org_settings.favicon_url → the earliest active location's
// company_settings.favicon_url in that org). A CRM host, an unmapped host,
// an org with no icon, and any DB failure all get the PLATFORM mark.
//
// PERFORMANCE: this runs in the ROOT layout's generateMetadata, so the
// answer is held in a module-level TTL cache KEYED BY HOST (one read set
// per host per window per lambda, failures cached too). Never throws.

import { createServerClient } from './supabase'
import { resolveTenantOrgId } from './tenant-domains-edge'
import { getOrgCustomerBranding } from './location-branding'
import { hostCacheKey } from './default-site-name'

// The platform's own mark, served from public/ on EVERY host: the proxy
// matcher excludes *.svg, so a brand or tenant host never rewrites it.
// (The pre-W1.L4 floor was Stillorgan's uploaded favicon.png — UN1T's icon
// on every tenant's tab; UN1T's hosts still resolve it through the chain.)
export const PLATFORM_FAVICON_URL = '/repset-mark.svg'

export const FAVICON_CACHE_TTL_MS = 5 * 60 * 1000 // favicon churn is rare

const MAX_CACHED_HOSTS = 256
let cache = new Map()

// Test hook — the module-level cache would otherwise leak between tests.
export function _resetDefaultFaviconCache() {
  cache = new Map()
}

/**
 * Resolve the favicon URL for a request host. Never throws; on any
 * miss/error it returns (and caches) PLATFORM_FAVICON_URL.
 *
 * @param {{ host?: string|null, db?: object, nowMs?: number }} [opts]
 *   host: the raw `Host` header — `(await headers()).get('host')` in a layout.
 * @returns {Promise<string>}
 */
export async function resolveDefaultFaviconUrl({ host = '', db = null, nowMs = Date.now() } = {}) {
  const key = hostCacheKey(host)
  const hit = cache.get(key)
  if (hit && nowMs - hit.at < FAVICON_CACHE_TTL_MS) return hit.url
  let url = PLATFORM_FAVICON_URL
  try {
    const orgId = await resolveTenantOrgId(key, { db })
    if (orgId) {
      const client = db || createServerClient()
      const { faviconUrl } = await getOrgCustomerBranding(client, orgId)
      if (faviconUrl) url = faviconUrl
    }
  } catch {
    /* fall through to the platform mark */
  }
  if (cache.size >= MAX_CACHED_HOSTS) cache.clear()
  cache.set(key, { url, at: nowMs })
  return url
}
