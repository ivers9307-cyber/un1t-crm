// WRCPACK.1 — who may download the WRC inspection pack for an organisation.
//
// The pack carries every employee's pay rate, contracted hours, leave and
// contract status across ALL of the organisation's studios, so it is the
// owner tier, never a manager's: a master, an org admin of that organisation
// (profile_organizations, mig 417), or an owner at one of its studios. The
// route (GET /api/schedule/reports/wrc-pack) enforces it; the Reporting tab
// only decides whether to SHOW the download.
//
// Pure and import-free so the browser and the server evaluate the one rule.
// A master passes with no organisation known; anyone else needs one.

const isMasterUser = (user) => Boolean(user && (user.isMaster || user.role === 'master' || user.profileRole === 'master'))

/**
 * @param {object|null} user  getCurrentUser() result (or its client copy)
 * @param {string|null} orgId  the organisation the pack is for
 * @returns {boolean}
 */
export function canDownloadWrcPack(user, orgId) {
  if (!user) return false
  if (isMasterUser(user)) return true
  if (!orgId) return false
  if ((user.orgAdminOrgIds || []).includes(orgId)) return true
  const ownerLocationIds = Object.entries(user.rolesByLocation || {})
    .filter(([, role]) => role === 'owner')
    .map(([locationId]) => locationId)
  return (user.locations || []).some((l) => l && ownerLocationIds.includes(l.id) && l.organization_id === orgId)
}
