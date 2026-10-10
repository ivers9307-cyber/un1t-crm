// Resolve operator-editable branding for one location, with org-level
// inheritance. Server-side send paths (Mia agent, WhatsApp template vars,
// churn win-back) use this so customer-facing copy reflects the configured
// brand instead of a hard-coded gym. The login/reset-password screens read
// the same data via /api/public/branding (which reuses this helper).
//
// Resolve order, PER FIELD:
//   location company_settings  ->  org org_settings (mig 317)  ->  locations.name
// so an org default fills in any field a location has not set, and a freshly
// provisioned location renders its org's brand before anyone configures it.
// W1.B1 (SaaS Wave 1, decision 3): the chain ENDS in the location's own name.
// The literal 'UN1T' floor (DEFAULT_COMPANY_NAME) is gone: a second gym's
// customers must never read another gym's wordmark, and a brand this module
// cannot resolve at all is the EMPTY string, so a caller renders nothing
// rather than the wrong gym.
//
// Takes an explicit `db` so it works under both the service-role and the
// request-scoped client. Never throws — a branding lookup must not break a
// send path; on any miss/error it returns the brand-neutral default.

import { logError } from './log.js'

const EMPTY = Object.freeze({
  companyName: '',
  shortName: '',
  locationName: '',
  companyNameConfigured: false,
  logoUrl: null,
  faviconUrl: null,
})

/**
 * @param {object} db          a supabase-js client
 * @param {string} locationId  the location whose branding to resolve
 * @returns {Promise<{ companyName: string, shortName: string, locationName: string, companyNameConfigured: boolean, logoUrl: string|null, faviconUrl: string|null }>}
 *          companyName: company_settings → org_settings → locations.name → ''.
 *          locationName (W1.S3): locations.name itself, the studio's own
 *          label, for merge fields that mean "this studio" rather than "the
 *          brand" ({{location_name}}); '' when the row is unreadable.
 *          shortName (W1.B1): org_settings.short_name (mig 715) when set,
 *          else companyName — the wordmark productName() in
 *          shared/brand-name.js builds "{Brand} Points" / "{Brand} HR" from.
 *          companyNameConfigured (LEGALENT.1): true only when an OPERATOR set
 *          the name (company_settings or org_settings). A location's name is
 *          a label, not a configured brand, so it leaves this false: a caller
 *          making a CLAIM about a company (a contract countersignature, a
 *          party clause) reads this flag, never the string — see
 *          src/lib/contracting-entity.js.
 */
export async function getLocationBranding(db, locationId) {
  if (!db || !locationId) return { ...EMPTY }
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

    // The org row is always consulted (W1.B1): even a fully configured
    // location takes its SHORT name from org_settings.short_name, and the
    // location-name floor lives on the same lookup. Two cheap indexed reads.
    const org = await getOrgBranding(db, locationId)
    if (org) {
      name = name || (org.company_name || '').trim()
      logoUrl = logoUrl || org.logo_url || null
      faviconUrl = faviconUrl || org.favicon_url || null
    }

    // Everything above this line is an operator's choice; the location
    // name below is a label the resolver borrows when nobody chose one.
    const configuredName = name
    name = name || org?.locationName || ''

    return {
      companyName: name,
      shortName: (org?.short_name || '').trim() || name,
      locationName: org?.locationName || '',
      companyNameConfigured: Boolean(configuredName),
      logoUrl,
      faviconUrl,
    }
  } catch {
    logError('location-branding', 'unresolved', { locationId })
    return { ...EMPTY }
  }
}

/**
 * HOST-CONSENT.1 — the ORGANISATION's customer-facing brand name, for copy
 * that speaks for the whole org rather than one studio (the two-consent
 * sentences on /h/[slug] and hosted-event registration). org_settings
 * (mig 317) is operator-editable via /api/settings/org-branding; never
 * organizations.name, which is the ops tenant label ("UN1T Group").
 *
 * W1.B1 chain: org_settings.company_name → the org's master location's name
 * (organizations.master_location_id, mig 464) → the earliest active
 * location's name in the org → ''. Never throws; never a literal.
 * @param {object} db
 * @param {string|null} organizationId
 * @returns {Promise<string>}
 */
export async function getOrgBrandName(db, organizationId) {
  if (!db || !organizationId) return ''
  try {
    const { data, error } = await db
      .from('org_settings')
      .select('company_name')
      .eq('organization_id', organizationId)
      .limit(1)
    const configured = (!error && data && data[0]?.company_name || '').trim()
    if (configured) return configured

    const { data: orgRows, error: orgErr } = await db
      .from('organizations')
      .select('master_location_id')
      .eq('id', organizationId)
      .limit(1)
    const masterId = (!orgErr && orgRows && orgRows[0]?.master_location_id) || null
    if (masterId) {
      const { data: masterRows, error: masterErr } = await db
        .from('locations')
        .select('name')
        .eq('id', masterId)
        .limit(1)
      const masterName = (!masterErr && masterRows && masterRows[0]?.name || '').trim()
      if (masterName) return masterName
    }

    const { data: locRows, error: locErr } = await db
      .from('locations')
      .select('name')
      .eq('organization_id', organizationId)
      .eq('active', true)
      .order('created_at')
      .limit(1)
    return (!locErr && locRows && locRows[0]?.name || '').trim()
  } catch {
    logError('location-branding', 'org brand unresolved', { organizationId })
    return ''
  }
}

// Resolve the location's own name plus the org_settings row (mig 317) for
// the organisation that owns `locationId`: location -> organization_id ->
// org_settings. Returns null only when the location row itself is
// unreadable; a location with no organisation, or an org with no settings
// row, still yields its `locationName` so the brand chain can end there.
// Swallows its own errors so a flaky org query can never downgrade an
// otherwise-good location brand.
async function getOrgBranding(db, locationId) {
  try {
    const { data: locRows, error: locErr } = await db
      .from('locations')
      .select('name, organization_id')
      .eq('id', locationId)
      .limit(1)
    const loc = (!locErr && locRows && locRows[0]) || null
    if (!loc) return null
    const base = {
      locationName: (loc.name || '').trim(),
      company_name: null,
      short_name: null,
      logo_url: null,
      favicon_url: null,
    }
    if (!loc.organization_id) return base
    const { data: orgRows, error: orgErr } = await db
      .from('org_settings')
      .select('company_name, short_name, logo_url, favicon_url')
      .eq('organization_id', loc.organization_id)
      .limit(1)
    if (orgErr || !orgRows || !orgRows[0]) return base
    return { ...base, ...orgRows[0] }
  } catch {
    return null
  }
}
