// Server-side permission helper — single function shared by every
// page-level permission gate.
//
// Three-tier resolution:
//   1. LOCATION gate (migration 032) — if the user's active location
//      has features[key] === false, the answer is DENIED regardless
//      of what's on the user. Notification preferences (notify_*)
//      are exempt from this gate (see isFeatureGatedByLocation in
//      shared/permissions.js).
//   2. USER override — permissions[key] === true | false → that wins.
//   3. ROLE default — fall back to DEFAULT_WEB_PERMISSIONS_BY_ROLE
//      for the user's role.
//
// Owners are NOT special-cased here — if an owner toggles a feature
// off on their own profile (or off at their location), the toggle is
// honoured. Privileged admin actions (staff edit, branding upload,
// location feature edits) remain owner-only via separate
// `if (user.role !== 'owner') ...` checks inside those routes.
//
// Multi-location users: their `activeLocation` is what determines
// the location-gate. Switching active location can change which
// features the same user can access.

import { DEFAULT_WEB_PERMISSIONS_BY_ROLE, isFeatureEnabledAtLocation } from '@shared/permissions'

/**
 * @param {{role: string, permissions?: object, activeLocation?: {features?: object}} | null | undefined} user
 * @param {string} key  e.g. 'dashboard_personal', 'pipeline', 'settings'
 * @returns {boolean}
 */
export function hasPermission(user, key) {
  if (!user) return false

  // Master role bypasses every gate (mig 033). Platform super-admin
  // sees and edits everything regardless of location feature flags
  // or per-user permission overrides.
  if (user.role === 'master') return true

  // Tier 1: location gate.
  if (!isFeatureEnabledAtLocation(user.activeLocation, key)) return false

  // Tier 2: user override.
  const perms = user.permissions || {}
  if (key in perms) return perms[key] === true

  // Tier 3: role default.
  return DEFAULT_WEB_PERMISSIONS_BY_ROLE[user.role]?.[key] === true
}
