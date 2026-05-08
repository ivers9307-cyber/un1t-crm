// Mobile permissions helper.
//
// On the web, permissions.<key> controls sidebar visibility. On mobile,
// permissions.mobile.<key> controls tab/screen visibility — separate
// namespace so disabling something on the web doesn't accidentally
// disable it on mobile (and vice versa).
//
// Thin mobile-specific adapter around the canonical 3-tier resolver
// in shared/permissions.js. The tier ordering + master semantics
// live there so web and mobile can't drift; this file only specifies
// what's mobile-shaped:
//
//   • canMobile reads the per-user override from
//     `activeLocation.permissions.mobile[key]` (the .mobile namespace
//     scopes the toggle to phone/tablet only).
//   • canDashboard reads from `activeLocation.permissions[key]` (top
//     level — these three keys are intentionally cross-platform and
//     fall back to the web defaults map so a single admin toggle
//     covers both web and mobile dashboards).
//   • No `settings` escape hatch — mobile has no feature-toggle UI,
//     so the web's special-case for master + 'settings' isn't
//     needed here.
//
// The list of valid keys + their default-by-role values lives in
// ../../shared/permissions.js and is also imported by the web admin
// UI (StaffForm.jsx). Adding a new feature in that one file
// auto-flows here and to the parity linter (npm run check:mobile-parity).

import {
  MOBILE_PERMISSION_KEYS,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE, DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  resolvePermission,
} from '../../shared/permissions'

// Re-export the shared definitions so screens that need labels/hints
// (e.g. a future in-app notification preferences page) can import
// them from `../lib/permissions` instead of crossing the shared/
// boundary directly.
export {
  MOBILE_PERMISSIONS,
  MOBILE_PERMISSION_KEYS,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
  CROSS_PLATFORM_DASHBOARD_KEYS,
} from '../../shared/permissions'

/**
 * @param {object|null|undefined} profile     The safe profile from /api/mobile/me
 * @param {string} key                         e.g. 'schedule', 'pipeline', 'whatsapp', 'notify_swap'
 * @param {object|null|undefined} activeLocation  From /api/mobile/me — has .features and .permissions
 * @returns {boolean}
 */
export function canMobile(profile, key, activeLocation = null) {
  if (!profile) return false
  // Mobile keys live under .mobile in the assignment's permissions
  // blob. Hand the canonical resolver the namespaced bag.
  return resolvePermission({
    role: profile.role,
    location: activeLocation,
    permissions: activeLocation?.permissions?.mobile || null,
    defaults: DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
    key,
  })
}

/**
 * Returns true if any mobile feature is enabled at the user's active
 * location. Used to decide whether to show the empty-state "ask an
 * admin" nudge on Home. Walks every defined mobile key through
 * canMobile so any tier-2 / tier-3 override is honoured.
 */
export function hasAnyMobileFeature(profile, activeLocation = null) {
  if (!profile) return false
  return MOBILE_PERMISSION_KEYS.some(k => canMobile(profile, k, activeLocation))
}

/**
 * Cross-platform dashboard permission check. The dashboard sub-views
 * (`dashboard_personal`, `dashboard_studio`, `dashboard_business`)
 * live at the TOP LEVEL of the per-location permissions blob (not
 * under .mobile), so a single admin toggle controls visibility on
 * both web and mobile. Use this instead of canMobile() for any of
 * those keys.
 *
 * Honours the location gate too — a dashboard turned off at the
 * active location is hidden for every user there.
 *
 * @param {object|null|undefined} profile
 * @param {string} key  one of dashboard_personal | dashboard_studio | dashboard_business
 * @param {object|null|undefined} activeLocation
 * @returns {boolean}
 */
export function canDashboard(profile, key, activeLocation = null) {
  if (!profile) return false
  // Dashboard sub-views live at the TOP level of the permissions
  // bag (no .mobile namespace) and fall back to the WEB defaults
  // map — a single admin toggle controls visibility on both web
  // and mobile dashboards.
  return resolvePermission({
    role: profile.role,
    location: activeLocation,
    permissions: activeLocation?.permissions || null,
    defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
    key,
  })
}
