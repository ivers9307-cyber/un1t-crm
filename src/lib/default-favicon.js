// SAAS-7 — deployment-default favicon for the root layout.
//
// The root layout used to hardcode a public-storage URL containing the
// seeded Stillorgan UUID — a tenant hardcode in the one file every page
// renders through. The favicon is operator-editable (/settings →
// BrandingSettings writes company_settings.favicon_url via
// /api/settings/branding/upload), so resolve it from there instead.
//
// WHICH tenant's favicon? The CRM hostname serves every tenant and the
// brand registry (src/lib/brands.js) carries no brand→tenant linkage
// yet, so — mirroring the anonymous branch of /api/public/branding
// (login screen, no location known) — we take the first configured
// company_settings row, ordered by location_id so the pick is stable.
//
// SAAS-8 HANDOFF: when tenant_domains maps the request hostname to an
// organization, thread the host in from the layout and resolve that
// org's favicon here; the cache below can then key by host.
//
// PERFORMANCE: this runs in the ROOT layout's generateMetadata, so a
// naive implementation is a DB read on every request. A module-level
// TTL cache (the pattern is per-lambda; a cold start pays one read)
// bounds that, and the pre-SAAS-7 hardcoded URL stays as the ultimate
// fallback so UN1T renders identically on a cache miss / DB blip —
// including during `next build`, where local env keys may be stubs.

import { createServerClient } from './supabase'

// The exact URL the layout hardcoded before SAAS-7 (Stillorgan's
// uploaded favicon). Ultimate fallback — never remove without checking
// the object still exists in the branding bucket.
export const LEGACY_FAVICON_URL =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/a0000000-0000-0000-0000-000000000001/favicon.png'

export const FAVICON_CACHE_TTL_MS = 5 * 60 * 1000 // favicon churn is rare

let cache = { url: null, at: 0 }

// Test hook — the module-level cache would otherwise leak between tests.
export function _resetDefaultFaviconCache() {
  cache = { url: null, at: 0 }
}

/**
 * Resolve the deployment-default favicon URL. Never throws; on any
 * miss/error it returns (and caches) LEGACY_FAVICON_URL. The failure
 * result is cached too so a down DB costs one read per TTL window, not
 * one per request.
 *
 * @param {{ db?: object, nowMs?: number }} [opts]  Injectable for tests.
 * @returns {Promise<string>}
 */
export async function resolveDefaultFaviconUrl({ db = null, nowMs = Date.now() } = {}) {
  if (cache.url && nowMs - cache.at < FAVICON_CACHE_TTL_MS) return cache.url
  let url = LEGACY_FAVICON_URL
  try {
    const client = db || createServerClient()
    const { data, error } = await client
      .from('company_settings')
      .select('favicon_url')
      .not('favicon_url', 'is', null)
      .order('location_id')
      .limit(1)
    const configured = (!error && data && data[0]?.favicon_url) || null
    if (configured) url = configured
  } catch {
    /* fall through to the legacy fallback */
  }
  cache = { url, at: nowMs }
  return url
}
