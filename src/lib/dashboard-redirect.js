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
import { resolveLandingPreference, LANDING_PREFERENCE_TARGETS } from '@shared/permissions'

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

  return null
}
