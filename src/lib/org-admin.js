// C18 ORGROLE.1 — who may act at the ORGANISATION level.
//
// Richard's decision (1 Oct 2026): organisation-level pages and routes
// (billing, the usage wallet, API keys, the email sending domain, org
// branding and usage caps, contracts and contract templates, the host
// back-fill admin jobs, the staff device fleet, the org event-fee report)
// are for ORGANISATION ADMINS only: a master, or a person holding an
// `org_admin` grant on that organisation (profile_organizations, mig 417;
// getCurrentUser exposes it as `user.orgAdminOrgIds`). An owner at one
// studio, or at every studio, is NOT an organisation admin.
//
// Before this, those surfaces asked the ACTIVE studio's role
// (`user.role === 'owner'`, ADMIN_ROLES, `hasPermission(user, 'settings')`)
// and/or getOwnerOrganizationIds (per-studio owner roles mapped to their
// organisations). Both answer a studio question, not an organisation one.
//
// Pure and import-free on purpose: the settings tree and client components
// evaluate the same rule the routes do (UI gating = route rule). The
// response-shaped twin for routes is assertOrganizationAdmin in auth.js.

const isMasterUser = (user) => Boolean(user && (user.isMaster || user.role === 'master'))

/** The organisations a non-master holds an org_admin grant on (deduped). */
export function adminOrganizationIds(user) {
  if (!user) return []
  return Array.from(new Set((user.orgAdminOrgIds || []).filter(Boolean)))
}

/**
 * Master, or an org admin of `orgId`. A null org is master-only.
 * @param {object|null} user  getCurrentUser() result (or its client copy)
 * @param {string|null} orgId
 */
export function isOrgAdmin(user, orgId) {
  if (!user) return false
  if (isMasterUser(user)) return true
  if (!orgId) return false
  return adminOrganizationIds(user).includes(orgId)
}

/** The coarse pre-check before the target organisation is known. */
export function isOrgAdminSomewhere(user) {
  if (!user) return false
  return isMasterUser(user) || adminOrganizationIds(user).length > 0
}

/** The organisation the caller is working in (the active studio's). */
export function activeOrganizationId(user) {
  return user?.activeOrganization?.id || user?.activeLocation?.organization_id || null
}

/** Is the caller an admin of the organisation they are working in? */
export function isActiveOrgAdmin(user) {
  return isOrgAdmin(user, activeOrganizationId(user))
}

/**
 * Resolve the organisation an org-level settings surface acts on.
 *   - master: the requested org, else the active one (null when neither).
 *   - else, an explicit request: that org when they are an admin of it, else
 *     { notFound: true } (callers answer 404, so org ids cannot be probed).
 *   - else, nothing requested: the active org when they are an admin of it;
 *     with no active org, their first admin org; otherwise { orgId: null }
 *     (callers answer 403 / redirect: "no organisation access").
 * @returns {{ orgId: string|null } | { notFound: true }}
 */
export function resolveAdminOrgId(user, requested) {
  if (isMasterUser(user)) {
    return { orgId: requested || activeOrganizationId(user) || null }
  }
  const admin = adminOrganizationIds(user)
  if (requested) return admin.includes(requested) ? { orgId: requested } : { notFound: true }
  const active = activeOrganizationId(user)
  if (active) return { orgId: admin.includes(active) ? active : null }
  return { orgId: admin[0] || null }
}
