// SAAS-7 / W1.L4 — the favicon for a request, resolved by its HOST.
//
// The root layout used to hardcode a public-storage URL containing the
// seeded Stillorgan UUID — a tenant hardcode in the one file every page
// renders through. SAAS-7 made it operator-editable (/settings →
// BrandingSettings writes company_settings.favicon_url via
// /api/settings/branding/upload) but resolved "the first configured row in
// the estate", so one tenant's icon labelled every tenant's tabs — and the
// CRM's. W1.L4 (SaaS Wave 1, decision 4) resolves by the REQUEST HOST's
// organisation instead, through the one per-host brand cache in
// host-brand.js (the same walk the site name and the anonymous branding
// route read: org_settings.favicon_url → the earliest active location's
// company_settings.favicon_url in that org). A CRM host, an unmapped host,
// an org with no icon, and any DB failure all get the PLATFORM mark.

import { resolveHostBrand, HOST_BRAND_CACHE_TTL_MS, _resetHostBrandCache } from './host-brand'

// The platform's own mark, served from public/ on EVERY host: the proxy
// matcher excludes *.svg, so a brand or tenant host never rewrites it.
// (The pre-W1.L4 floor was Stillorgan's uploaded favicon.png — UN1T's icon
// on every tenant's tab; UN1T's hosts still resolve it through the chain.)
export const PLATFORM_FAVICON_URL = '/repset-mark.svg'

export const FAVICON_CACHE_TTL_MS = HOST_BRAND_CACHE_TTL_MS

// Test hook — resets the shared per-host brand cache.
export const _resetDefaultFaviconCache = _resetHostBrandCache

/**
 * Resolve the favicon URL for a request host. Never throws; on any
 * miss/error it returns PLATFORM_FAVICON_URL.
 *
 * @param {{ host?: string|null, db?: object, nowMs?: number }} [opts]
 *   host: the raw `Host` header — `(await headers()).get('host')` in a layout.
 * @returns {Promise<string>}
 */
export async function resolveDefaultFaviconUrl(opts = {}) {
  const { faviconUrl } = await resolveHostBrand(opts)
  return faviconUrl || PLATFORM_FAVICON_URL
}
