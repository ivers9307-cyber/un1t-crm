// Mobile permissions helper.
//
// On the web, permissions.<key> controls sidebar visibility. On mobile,
// permissions.mobile.<key> controls tab/screen visibility — separate
// namespace so disabling something on the web doesn't accidentally
// disable it on mobile (and vice versa).
//
// Three-tier resolution (mirrors src/lib/permissions.js on the web):
//   1. LOCATION gate (migration 032) — activeLocation.features[key]
//      explicitly false → DENIED for everyone at that location,
//      regardless of role default or per-user mobile permission. This
//      gate applies to MASTER too — if a location has a feature off,
//      it's off, full stop. (The web has a small escape hatch on the
//      'settings' key so a master can navigate to flip features back
//      on; mobile has no feature-toggle UI, so no escape hatch is
//      needed here.) Notification preferences (notify_*) are exempt —
//      see isFeatureGatedByLocation in shared/permissions.js.
//   2. PER-LOCATION USER override (migration 058) — explicit true/false
//      in the active assignment's permissions blob wins. Reads
//      `activeLocation.permissions.mobile[key]` for mobile keys, and
//      `activeLocation.permissions[key]` for cross-platform dashboard
//      keys. The override layer used to live profile-wide on
//      profile.permissions.mobile, which leaked across locations for
//      mixed-role users (owner@A, staff@B → got owner mobile toggles
//      at B). Now per-assignment.
//   3. ROLE default — DEFAULT_MOBILE_PERMISSIONS_BY_ROLE for the
//      active-location role.
//
// The list of valid keys + their default-by-role values lives in
// ../../shared/permissions.js and is also imported by the web admin
// UI (StaffForm.jsx). Adding a new feature in that one file
// auto-flows here and to the parity linter (npm run check:mobile-parity).

import {
  isFeatureEnabledAtLocation, MOBILE_PERMISSION_KEYS,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE, DEFAULT_WEB_PERMISSIONS_BY_ROLE,
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
  // Tier 1: location gate. Applies to ALL roles including master —
  // if the location has the feature off, it's off for everyone there.
  if (!isFeatureEnabledAtLocation(activeLocation, key)) return false
  // Master bypasses tiers 2 + 3 — once the location says yes, master
  // sees it without needing a per-user permission entry.
  if (profile.role === 'master') return true
  // Tier 2: per-location user override (mig 058). Mobile keys live
  // under .mobile in the assignment's permissions blob.
  const m = activeLocation?.permissions?.mobile
  if (m && typeof m === 'object' && key in m) return m[key] === true
  // Tier 3: role default at the active-location role.
  const defaults = DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[profile.role] || {}
  return defaults[key] === true
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
  // Tier 1: location gate. Applies to ALL roles including master.
  if (!isFeatureEnabledAtLocation(activeLocation, key)) return false
  // Master bypasses the per-user permission check.
  if (profile.role === 'master') return true
  // Tier 2: per-location user override (mig 058).
  const perms = activeLocation?.permissions
  if (perms && typeof perms === 'object' && key in perms) return perms[key] === true
  // Tier 3: role default at the active-location role.
  const defaults = DEFAULT_WEB_PERMISSIONS_BY_ROLE[profile.role] || {}
  return defaults[key] === true
}
