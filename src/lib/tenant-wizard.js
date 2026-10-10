// SAAS4-P2 — pure state derivation for the tenant provisioning wizard
// (/admin/tenants/new). Every completed step writes a REAL resource via
// an existing route, and the wizard records progress in the URL query —
// so a refresh (or coming back tomorrow) resumes exactly where the
// operator left off, with no wizard-state table to keep honest.
//
//   org      → organizations row exists        (?org=<id>)
//   location → locations row exists (+ seeds)  (&loc=<id>)
//   owner    → invite sent                     (&invited=1)
//   branding → org branding saved or skipped   (&branded=1|skip)
//   domain   → tenant_domains row or skipped   (&domain=1|skip)

export const WIZARD_STEPS = Object.freeze([
  { key: 'org', label: 'Organisation' },
  { key: 'location', label: 'First location' },
  { key: 'owner', label: 'Invite owner' },
  { key: 'branding', label: 'Branding' },
  { key: 'domain', label: 'Subdomain' },
  { key: 'done', label: 'Finish' },
])

/**
 * @param {Record<string, string|undefined>} params - URL query params
 * @returns {{ step: string, orgId: string|null, locationId: string|null }}
 */
export function deriveWizardState(params = {}) {
  const orgId = params.org || null
  const locationId = orgId ? params.loc || null : null

  let step = 'org'
  if (orgId) step = 'location'
  if (orgId && locationId) step = 'owner'
  if (orgId && locationId && params.invited) step = 'branding'
  if (orgId && locationId && params.invited && params.branded) step = 'domain'
  if (orgId && locationId && params.invited && params.branded && params.domain) step = 'done'

  return { step, orgId, locationId }
}

/**
 * W1.E1 — the org-admin grant the owner step sends right after the
 * invite: PUT /api/staff/[id]/org-admin is DESIRED-STATE (the full list
 * of orgs), master-only, which the wizard already is. A new tenant's
 * owner needs this grant to reach /settings/email-domain (the org-admin
 * gate; 0 profile_organizations rows existed anywhere before W1.E1).
 *
 * @param {string|null} profileId - the invited profile's id (POST /api/staff → data.id)
 * @param {string|null} orgId
 * @returns {{ url: string, method: 'PUT', body: { organization_ids: string[] } }|null}
 */
export function orgAdminGrantRequest(profileId, orgId) {
  if (!profileId || !orgId) return null
  return {
    url: `/api/staff/${encodeURIComponent(profileId)}/org-admin`,
    method: 'PUT',
    body: { organization_ids: [orgId] },
  }
}

/**
 * W1.E1 — where a plan is PINNED to a tenant's locations: the drill-in
 * /admin/tenants/[orgId] (TenantDetailView). /admin/plans is the
 * catalogue editor and pins nothing — the wizard used to link it.
 * @param {string|null} orgId
 */
export function tenantPlansHref(orgId) {
  return orgId ? `/admin/tenants/${encodeURIComponent(orgId)}` : '/admin/tenants'
}
