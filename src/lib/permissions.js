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
