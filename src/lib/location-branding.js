// Resolve operator-editable branding for one location, with org-level
// inheritance. Server-side send paths (Mia agent, WhatsApp template vars,
// churn win-back) use this so customer-facing copy reflects the configured
// brand instead of a hard-coded "UN1T". The login/reset-password screens read
// the same data via /api/public/branding (which reuses this helper).
//
// Resolve order, PER FIELD:
//   location company_settings  ->  org org_settings (mig 317)  ->  'UN1T'
// so an org default fills in any field a location has not set, and a freshly
// provisioned location renders its org's brand before anyone configures it.
//
// Takes an explicit `db` so it works under both the service-role and the
// request-scoped client. Never throws — a branding lookup must not break a
// send path; on any miss/error it returns the brand-neutral default.

const DEFAULT_COMPANY_NAME = 'UN1T'

/**
 * @param {object} db          a supabase-js client
 * @param {string} locationId  the location whose branding to resolve
 * @returns {Promise<{ companyName: string, companyNameConfigured: boolean, logoUrl: string|null, faviconUrl: string|null }>}
 *          companyName is always a non-empty string (defaults to 'UN1T').
 *          LEGALENT.1 added companyNameConfigured: false means nobody set a
 *          name and companyName is this module's literal default. Every
 *          existing caller renders a wordmark, for which the default is the
 *          right answer; a caller making a CLAIM about a company (a contract
 *          countersignature, a party clause) must not treat one org's brand
 *          as another org's, so it reads this flag — see
 *          src/lib/contracting-entity.js.
 */
export async function getLocationBranding(db, locationId) {
  const fallback = {
    companyName: DEFAULT_COMPANY_NAME,
    companyNameConfigured: false,
    logoUrl: null,
    faviconUrl: null,
  }
  if (!db || !locationId) return fallback
  try {
    const { data, error } = await db
      .from('company_settings')
      .select('company_name, logo_url, favicon_url')
      .eq('location_id', locationId)
      .limit(1)
    const row = (!error && data && data[0]) || null
    let name = (row?.company_name || '').trim()
    let logoUrl = row?.logo_url || null
    let faviconUrl = row?.favicon_url || null

    // Fully configured at the location level — no org lookup needed.
    if (name && logoUrl && faviconUrl) {
      return { companyName: name, companyNameConfigured: true, logoUrl, faviconUrl }
    }

    // Inherit any unset field from the location's organisation defaults.
    const org = await getOrgBranding(db, locationId)
    if (org) {
      name = name || (org.company_name || '').trim()
      logoUrl = logoUrl || org.logo_url || null
      faviconUrl = faviconUrl || org.favicon_url || null
    }

    return {
      companyName: name || DEFAULT_COMPANY_NAME,
      companyNameConfigured: Boolean(name),
      logoUrl,
      faviconUrl,
    }
  } catch {
    return fallback
  }
}

// Resolve the org_settings row (mig 317) for the organisation that owns
// `locationId`: location -> organization_id -> org_settings. Two cheap
// indexed lookups, only reached when the location row leaves a field unset.
// Swallows its own errors and returns null so a flaky org query can never
// downgrade an otherwise-good location brand.
async function getOrgBranding(db, locationId) {
  try {
    const { data: locRows, error: locErr } = await db
      .from('locations')
      .select('organization_id')
      .eq('id', locationId)
      .limit(1)
    const orgId = (!locErr && locRows && locRows[0]?.organization_id) || null
    if (!orgId) return null
    const { data: orgRows, error: orgErr } = await db
      .from('org_settings')
      .select('company_name, logo_url, favicon_url')
      .eq('organization_id', orgId)
      .limit(1)
    if (orgErr || !orgRows || !orgRows[0]) return null
    return orgRows[0]
  } catch {
    return null
  }
}
