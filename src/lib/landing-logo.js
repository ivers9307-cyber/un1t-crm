// SAAS-7 — operator-editable logo resolution for the code-defined Meta-ad
// landing pages (/start, /free-class).
//
// Both pages hardcoded Stillorgan's landing-page logo URL. The
// operator-editable source for a landing page's logo is
// landing_page_settings.logo_url — the SAME field /stillorgan and
// /hatch-street render through (see src/app/welcome/[location]/page.js),
// and whose live value is byte-identical to the URL these pages
// hardcoded, so resolution changes nothing visually for UN1T today.
//
// Deliberately NOT getLocationBranding: company_settings.logo_url is the
// CRM/email brand logo, a DIFFERENT image from the landing-page wordmark
// — routing live paid-traffic pages through it would silently swap the
// rendered logo. Landing pages resolve landing-page branding.
//
// Never throws — these are live ad landing pages; on any miss/error the
// caller's fallback (the pre-SAAS-7 hardcoded URL) renders instead.

import { createServerClient } from './supabase'

// The exact URL /start + /free-class hardcoded before SAAS-7 —
// Stillorgan's landing_page_settings.logo_url as of the migration.
// Kept as the explicit fallback so the pages render pixel-identically
// on a missing row / DB blip.
export const STILLORGAN_LANDING_LOGO =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/a0000000-0000-0000-0000-000000000001/de12ffbe-22db-4c34-b307-8983488ffd96.png'

/**
 * Pure resolution: the row's configured logo_url, else the fallback.
 * @param {{ logo_url?: string|null }|null} row
 * @param {string} fallback
 * @returns {string}
 */
export function resolveLandingLogo(row, fallback) {
  const url = typeof row?.logo_url === 'string' ? row.logo_url.trim() : ''
  return url || fallback
}

/**
 * Load the logo for a landing page by its public_path. Fail-soft: any
 * miss/error returns the fallback.
 *
 * @param {string} publicPath  landing_page_settings.public_path (e.g. 'stillorgan')
 * @param {string} fallback    URL to render when unconfigured/unreachable
 * @param {object} [db]        Injectable for tests.
 * @returns {Promise<string>}
 */
export async function getLandingLogo(publicPath, fallback, db = null) {
  try {
    const client = db || createServerClient()
    const { data, error } = await client
      .from('landing_page_settings')
      .select('logo_url')
      .eq('public_path', publicPath)
      .maybeSingle()
    if (error) return fallback
    return resolveLandingLogo(data, fallback)
  } catch {
    return fallback
  }
}
