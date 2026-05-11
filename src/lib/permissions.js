// Server-side permission helper — single function shared by every
// page-level permission gate.
//
// Thin web-specific adapter around the canonical 3-tier resolver
// in shared/permissions.js. The tier ordering + master semantics
// live there so web and mobile can't drift; this file only adds
// the bits that are web-specific:
//
//   • Master gets `settings` even when the location says no — an
//     escape hatch so a master at a feature-disabled location can
//     still navigate to /settings/locations/[id] to flip the
//     toggles back on. Mobile has no settings UI, so no equivalent.
//   • Reads the per-user override from `user.activeAssignment
//     .permissions` (an aggregated object built by getCurrentUser)
//     rather than walking profile_locations directly.
//
// Owners are NOT special-cased here — if an owner toggles a feature
// off on their own profile (or off at their location), the toggle is
// honoured. Privileged admin actions (staff edit, branding upload,
// location feature edits) remain owner-only via separate
// `if (user.role !== 'owner') ...` checks inside those routes.
//
// Multi-location users: BOTH `activeLocation` (gate) and
// `activeAssignment` (override + role) follow the active location,
// so switching location can change which features the same user
// can access.

import {
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  resolvePermission,
} from '@shared/permissions'

/**
 * @param {{
 *   role: string,
 *   activeLocation?: {features?: object},
 *   activeAssignment?: {permissions?: object} | null,
 * } | null | undefined} user
 * @param {string} key  e.g. 'dashboard_personal', 'pipeline', 'settings'
 * @returns {boolean}
 */
export function hasPermission(user, key) {
  if (!user) return false

  // Master escape hatch — Settings sidebar entry stays visible
  // unconditionally so a master can always navigate to the
  // per-location feature toggles. The route itself is master+owner
  // gated inside the page handler.
  if (user.role === 'master' && key === 'settings') return true

  return resolvePermission({
    role: user.role,
    location: user.activeLocation,
    permissions: user.activeAssignment?.permissions || {},
    defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
    key,
  })
}

/**
 * Same three-tier resolver as hasPermission(), but checks against a
 * SPECIFIC location (not the user's active one). Used by API routes
 * that take an explicit `location_id` parameter — the caller might
 * be a master switching between locations whose active context lags
 * behind the route's target.
 *
 * Resolves the user's role at the given location via
 * user.locations[].role (which getCurrentUser populates from
 * profile_locations). Master is global — its role isn't location-
 * specific, so we use user.role unchanged for the master case.
 *
 * @param {object} user           — getCurrentUser() result
 * @param {string} locationId
 * @param {string} key            — WEB_PERMISSIONS key
 * @returns {boolean}
 */
export function hasPermissionForLocation(user, locationId, key) {
  if (!user || !locationId) return false

  // Master escape hatch — same rationale as hasPermission().
  if (user.role === 'master' && key === 'settings') return true

  // Master is global; for any other role we need the per-location
  // assignment to know what role they hold there.
  const assignment = user.assignmentsByLocation?.[locationId] || null
  const location   = (user.locations || []).find((l) => l.id === locationId) || null
  const roleHere   = user.role === 'master' ? 'master' : (assignment?.role || location?.role || null)
  if (!roleHere) return false

  return resolvePermission({
    role: roleHere,
    location, // location.features carries the tier-1 gate
    permissions: assignment?.permissions || {},
    defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
    key,
  })
}
