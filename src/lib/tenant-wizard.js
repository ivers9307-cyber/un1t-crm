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
