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

// CHROME.1 REVIEW — one string cannot serve both audiences, so there are TWO
// resolvers here and the difference is only the FLOOR:
//
//   resolveDefaultSiteName()  → operator name, else PLATFORM_SITE_NAME
//                               ("Repset"). The root layout. Right for the
//                               ~160 staff pages that inherit it.
//   resolveGymSiteName()      → operator name, else (since W1.B1) the SAME
//                               PLATFORM_SITE_NAME floor. The customer-facing
//                               layouts.
//
// Why the split existed: prod's ONE company_settings row had company_name
// NULL and org_settings was empty when CHROME.1 landed, so the floor was
// what actually rendered, and customers on /book, /event-pay and
// /host-connect were floored on the gym wordmark literal
// (DEFAULT_COMPANY_NAME) while staff tabs were floored on Repset.
//
// W1.B1 (SaaS Wave 1, decision 3) removed that literal from
// location-branding.js: a second gym's customers must never read another
// gym's wordmark, and a deployment-wide "first configured row" cannot know
// WHICH gym a customer is dealing with anyway. So until W1.L4 resolves the
// customer-facing name by the REQUEST'S HOST (tenant_domains → organisation
// → getLocationBranding), the gym resolver floors on the platform name too.
// The two functions are kept as separate seams so W1.L4 can rewire the
// customer side without touching the staff side.

import { createServerClient } from './supabase'

// The platform's own name. Used only when NO operator has configured a
// company name — at that point there is no gym identity to show, and the
// product this deployment is running IS Repset.
export const PLATFORM_SITE_NAME = 'Repset'

export const SITE_NAME_CACHE_TTL_MS = 5 * 60 * 1000 // renames are rare

let cache = { name: null, at: 0 }
let gymCache = { name: null, at: 0 }

// Test hook — the module-level caches would otherwise leak between tests.
export function _resetDefaultSiteNameCache() {
  cache = { name: null, at: 0 }
  gymCache = { name: null, at: 0 }
}

/**
 * The operator-configured company name, or null when nobody has set one.
 * Shared by both resolvers so they can never disagree about what "configured"
 * means — they differ ONLY in what they fall back to. Never throws.
 *
 * @param {object|null} db
 * @returns {Promise<string|null>}
 */
async function readConfiguredCompanyName(db) {
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
    if (configured && String(configured).trim()) return String(configured).trim()
  } catch {
    /* treat an unreadable row as "not configured" */
  }
  return null
}

/**
 * Resolve the PLATFORM-surface default site name — the root layout, i.e. the
 * staff CRM. Never throws; on any miss or error it returns (and caches)
 * PLATFORM_SITE_NAME. The failure result is cached too, so a down DB costs
 * one read per TTL window.
 *
 * Customer-facing routes must NOT inherit this — see resolveGymSiteName.
 *
 * @param {{ db?: object, nowMs?: number }} [opts]  Injectable for tests.
 * @returns {Promise<string>}
 */
export async function resolveDefaultSiteName({ db = null, nowMs = Date.now() } = {}) {
  if (cache.name && nowMs - cache.at < SITE_NAME_CACHE_TTL_MS) return cache.name
  const name = (await readConfiguredCompanyName(db)) || PLATFORM_SITE_NAME
  cache = { name, at: nowMs }
  return name
}

/**
 * Resolve the CUSTOMER-facing site name — booking pages, event payment, the
 * host portal, password reset, the member account pages. Same operator field;
 * since W1.B1 the same PLATFORM floor too (the gym literal is gone — see the
 * header). W1.L4 replaces this with resolution by the request's host, which
 * is the only way to floor on the RIGHT gym.
 *
 * Never throws, same TTL cache, same "cache the miss too" behaviour.
 *
 * @param {{ db?: object, nowMs?: number }} [opts]  Injectable for tests.
 * @returns {Promise<string>}
 */
export async function resolveGymSiteName({ db = null, nowMs = Date.now() } = {}) {
  if (gymCache.name && nowMs - gymCache.at < SITE_NAME_CACHE_TTL_MS) return gymCache.name
  const name = (await readConfiguredCompanyName(db)) || PLATFORM_SITE_NAME
  gymCache = { name, at: nowMs }
  return name
}

/**
 * Metadata for a customer-facing route subtree. Every customer/partner page
 * that inherited the root layout's metadata now imports this from its own
 * layout, so the gym's identity — not the platform's — labels the tab and the
 * link preview.
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
 * @param {{ db?: object, nowMs?: number }} [opts]
 * @returns {Promise<object>} a Next.js Metadata object
 */
export async function customerFacingMetadata(opts = {}) {
  const siteName = await resolveGymSiteName(opts)
  return {
    title: siteName,
    openGraph: { title: siteName, siteName, type: 'website' },
  }
}
