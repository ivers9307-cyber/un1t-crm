// Resolve operator-editable branding for one location from company_settings.
// Server-side send paths (Mia agent, WhatsApp template vars, churn win-back)
// use this so customer-facing copy reflects the location's configured brand
// instead of a hard-coded "UN1T". The login/reset-password screens read the
// same table via /api/public/branding (which reuses this helper).
//
// Takes an explicit `db` so it works under both the service-role and the
// request-scoped client. Never throws — a branding lookup must not break a
// send path; on any miss/error it returns the brand-neutral default.

const DEFAULT_COMPANY_NAME = 'UN1T'

/**
 * @param {object} db          a supabase-js client
 * @param {string} locationId  the location whose branding to resolve
 * @returns {Promise<{ companyName: string, logoUrl: string|null, faviconUrl: string|null }>}
 *          companyName is always a non-empty string (defaults to 'UN1T').
 */
export async function getLocationBranding(db, locationId) {
  const fallback = { companyName: DEFAULT_COMPANY_NAME, logoUrl: null, faviconUrl: null }
  if (!db || !locationId) return fallback
  try {
    const { data, error } = await db
      .from('company_settings')
      .select('company_name, logo_url, favicon_url')
      .eq('location_id', locationId)
      .limit(1)
    if (error || !data || data.length === 0) return fallback
    const row = data[0]
    const name = (row.company_name || '').trim()
    return {
      companyName: name || DEFAULT_COMPANY_NAME,
      logoUrl: row.logo_url || null,
      faviconUrl: row.favicon_url || null,
    }
  } catch {
    return fallback
  }
}
