// PERF.1 — single source of truth for "which dashboard should this
// user land on?" Used by both `/` (root) and `/dashboard` so that an
// authenticated visitor hitting either URL gets ONE redirect to the
// final destination instead of bouncing `/` → `/dashboard` →
// `/dashboard/<target>` (which Vercel Speed Insights measured at
// 9.58s P75 FCP on `/` despite the destination page itself
// rendering in 1.86s — the entire delta was redirect chain cost).
//
// Resolution order:
//   1. User-set landing preference (permissions.landing_preference)
//      — honoured if the user still has the matching permission at
//        the active location.
//   2. Smart default — most-aggregated dashboard the user can see
//      (Business → Studio → Today).
//   3. null — the user has no dashboard permissions; the caller is
//      expected to fall through to /dashboard's empty-state render.

import { hasPermission } from '@/lib/permissions'
import { getOwnerOrganizationIds } from '@/lib/auth'
import { resolveLandingPreference, LANDING_PREFERENCE_TARGETS } from '@shared/permissions'

// REPSET-ACCOUNT.1 — the Account Home (org portfolio) route. `/account`
// is taken by the per-user self-service account page, so the org
// portfolio lives at /portfolio.
export const ACCOUNT_HOME_ROUTE = '/portfolio'

/**
 * REPSET-ACCOUNT.1 — post-login ACCOUNT-tier landing decision.
 *
 * Decides whether an authenticated visitor hitting the login landing
 * (`/`) should be routed to the org portfolio instead of straight into
 * a single studio. Returns the portfolio route, or null to fall through
 * to the EXISTING per-studio behaviour (resolveDashboardTarget).
 *
 * Decision table:
 *   master (with an active org)            → /portfolio (Platform Console
 *                                            is a later phase)
 *   owner of the active org, ≥2 accessible
 *     studios in that org                  → /portfolio
 *   owner with 1 studio                    → null (studio dashboard, UNCHANGED)
 *   manager / head_coach / staff           → null (not account-tier)
 *   no active org / any error / ambiguity  → null (FAIL-SAFE: existing behaviour)
 *
 * Pure — no DB. Wrapped in try/catch so any unexpected shape degrades to
 * null (the existing landing) rather than throwing on the hot `/` path.
 * This decision is deliberately applied ONLY at `/` (the login landing),
 * NOT at `/dashboard`: `/dashboard` is the studio drill-in target
 * ("Open studio →" sets the active location and navigates there), so
 * redirecting multi-studio users away from it would create a bounce loop.
 *
 * @param {object|null} user  getCurrentUser() result
 * @returns {string|null}     the portfolio route, or null to fall through
 */
export function resolveLandingTarget(user) {
  try {
    if (!user) return null

    const isMaster = user.isMaster || user.profileRole === 'master' || user.role === 'master'
    if (isMaster) {
      // Master → their active org's Account Home (for now). No active
      // org → fall through to the existing dashboard resolution.
      return user.activeOrganization?.id ? ACCOUNT_HOME_ROUTE : null
    }

    const activeOrgId = user.activeOrganization?.id
    if (!activeOrgId) return null // missing/ambiguous org → existing behaviour

    // Only an account-tier operator (owner of the ACTIVE org) is routed to
    // the portfolio — a multi-studio manager stays in their studio.
    if (!getOwnerOrganizationIds(user).includes(activeOrgId)) return null

    // Count the caller's accessible studios WITHIN the active org.
    const orgStudioCount = (user.locations || [])
      .filter((l) => l && l.organization_id === activeOrgId).length

    return orgStudioCount >= 2 ? ACCOUNT_HOME_ROUTE : null
  } catch {
    return null // FAIL-SAFE — never break the login landing
  }
}

/**
 * Given an authenticated user object (must include role and
 * permissions), return the route they should land on, or null if
 * they have no dashboard permission at the active location.
 *
 * Pure — no DB calls. The user has already been resolved by
 * getCurrentUser() at the page entry.
 */
export function resolveDashboardTarget(user) {
  if (!user) return null

  // 1. User-set landing preference (no migration — top-level key on
  // profiles.permissions JSONB). Honour only if the user still has
  // permission for that dashboard. If the permission was revoked
  // after they set the preference, fall through to the smart-default
  // chain. 'auto' (and unset) also fall through.
  const pref = resolveLandingPreference(user)
  if (pref !== 'auto') {
    const target = LANDING_PREFERENCE_TARGETS[pref]
    if (target && hasPermission(user, target.perm)) {
      return target.route
    }
  }

  // 2. Smart default — most-aggregated dashboard the user can see.
  // Owner with all three on → Business; manager → Studio; staff →
  // Today. An owner who toggled them all off falls through to null.
  if (hasPermission(user, 'dashboard_business')) return '/dashboard/business'
  if (hasPermission(user, 'dashboard_studio'))   return '/dashboard/studio'
  if (hasPermission(user, 'dashboard_personal')) return '/dashboard/today'

  // 3. SIDEBAR-IA.1 — the radars are dashboard tabs now, so a user
  // holding only a radar permission still gets a landing target
  // instead of the "no dashboards" empty state.
  if (hasPermission(user, 'churn_radar')) return '/dashboard/churn-radar'
  if (hasPermission(user, 'lead_radar'))  return '/dashboard/lead-radar'
  // P2-7 — engagement analytics is a dashboard tab too; a user holding only
  // this permission still gets a landing target instead of the empty state.
  if (hasPermission(user, 'engagement_analytics')) return '/dashboard/engagement'
  // ADS-REPORT — /dashboard/ads is a dashboard tab; a user holding only this
  // permission still lands here instead of the "no dashboards" empty state.
  if (hasPermission(user, 'dashboard_ads')) return '/dashboard/ads'

  return null
}
