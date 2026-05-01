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
//      regardless of role default or per-user mobile permission.
//      Notification preferences (notify_*) are exempt — see
//      isFeatureGatedByLocation in shared/permissions.js.
//   2. USER override — permissions.mobile[key] === true → granted.
//   3. ROLE default is implicit on mobile: profile.permissions.mobile
//      is the source of truth (already populated server-side from
//      DEFAULT_MOBILE_PERMISSIONS_BY_ROLE at create-staff time).
//
// The list of valid keys + their default-by-role values lives in
// ../../shared/permissions.js and is also imported by the web admin
// UI (StaffForm.jsx). Adding a new feature in that one file
// auto-flows here and to the parity linter (npm run check:mobile-parity).
//
// Default: off. A profile predating mobile feature flags has no
// permissions.mobile object, in which case every key returns false
// and the user lands on the Home tab with everything else hidden.

import { isFeatureEnabledAtLocation } from '../../shared/permissions'

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
 * @param {object|null|undefined} activeLocation  From /api/mobile/me — has .features
 * @returns {boolean}
 */
export function canMobile(profile, key, activeLocation = null) {
  if (!profile) return false
  // Master bypasses every gate (mig 033).
  if (profile.role === 'master') return true
  if (!isFeatureEnabledAtLocation(activeLocation, key)) return false
  const m = profile.permissions?.mobile
  if (!m || typeof m !== 'object') return false
  return m[key] === true
}

/**
 * Returns true if any mobile feature is enabled at the user's active
 * location. Used to decide whether to show the empty-state "ask an
 * admin" nudge on Home.
 */
export function hasAnyMobileFeature(profile, activeLocation = null) {
  if (profile?.role === 'master') return true
  const m = profile?.permissions?.mobile
  if (!m || typeof m !== 'object') return false
  return Object.entries(m).some(([k, v]) =>
    v === true && isFeatureEnabledAtLocation(activeLocation, k)
  )
}

/**
 * Cross-platform dashboard permission check. The dashboard sub-views
 * (`dashboard_personal`, `dashboard_studio`, `dashboard_business`)
 * live at the TOP LEVEL of profile.permissions, not under .mobile,
 * so a single admin toggle controls visibility on both web and
 * mobile. Use this instead of canMobile() for any of those keys.
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
  if (profile?.role === 'master') return true
  if (!isFeatureEnabledAtLocation(activeLocation, key)) return false
  return profile?.permissions?.[key] === true
}
