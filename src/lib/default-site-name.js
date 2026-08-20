// CHROME.1 — deployment-default SITE NAME for the root layout's metadata.
//
// The root layout is the fallback metadata for BOTH audiences:
//   • ~160 of the 188 pages in this app are the STAFF CRM and carry no
//     metadata of their own, so this string labels almost every staff
//     browser tab — including on crm.repset.ie, where "UN1T Dublin" is
//     simply the wrong product name.
//   • a handful of customer-facing pages (event payment, host connect)
//     also inherit it, which is why the answer is NOT "hard-code Repset".
//     Per CLAUDE.md, anything naming the gym to a customer must come from
//     operator-editable branding, never a literal.
//
// So: resolve the operator's own `company_settings.company_name` — the same
// field /settings → BrandingSettings already writes and the login screen
// already renders — and fall back to the PLATFORM name only when no operator
// has configured one. That gives a Repset-branded deployment the right chrome
// today (company_name is unset in prod) and automatically defers to the
// operator's own name the moment they fill the field in.
//
// WHICH tenant's name? Same answer, and the same caveat, as
// resolveDefaultFaviconUrl: the CRM hostname serves every tenant and the
// brand registry carries no brand→tenant linkage, so take the first
// configured row ordered by location_id for a stable pick.
//
// SAAS-8 HANDOFF: when tenant_domains maps the request hostname to an
// organization, thread the host in from the layout and key the cache by host.
//
// PERFORMANCE: runs in the ROOT layout's generateMetadata, so it uses the
// same module-level TTL cache pattern as the favicon resolver — one DB read
// per lambda per window, never one per request. Never throws.

import { createServerClient } from './supabase'

// The platform's own name. Used only when NO operator has configured a
// company name — at that point there is no gym identity to show, and the
// product this deployment is running IS Repset.
export const PLATFORM_SITE_NAME = 'Repset'

export const SITE_NAME_CACHE_TTL_MS = 5 * 60 * 1000 // renames are rare

let cache = { name: null, at: 0 }

// Test hook — the module-level cache would otherwise leak between tests.
export function _resetDefaultSiteNameCache() {
  cache = { name: null, at: 0 }
}

/**
 * Resolve the deployment-default site name. Never throws; on any miss or
 * error it returns (and caches) PLATFORM_SITE_NAME. The failure result is
 * cached too, so a down DB costs one read per TTL window.
 *
 * @param {{ db?: object, nowMs?: number }} [opts]  Injectable for tests.
 * @returns {Promise<string>}
 */
export async function resolveDefaultSiteName({ db = null, nowMs = Date.now() } = {}) {
  if (cache.name && nowMs - cache.at < SITE_NAME_CACHE_TTL_MS) return cache.name
  let name = PLATFORM_SITE_NAME
  try {
    const client = db || createServerClient()
    const { data, error } = await client
      .from('company_settings')
      .select('company_name')
      .not('company_name', 'is', null)
      .order('location_id')
      .limit(1)
    const configured = (!error && data && data[0]?.company_name) || null
    // A whitespace-only name would render an empty tab title.
    if (configured && String(configured).trim()) name = String(configured).trim()
  } catch {
    /* fall through to the platform name */
  }
  cache = { name, at: nowMs }
  return name
}
