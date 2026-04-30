// Mobile permissions helper.
//
// On the web, permissions.<key> controls sidebar visibility. On mobile,
// permissions.mobile.<key> controls tab/screen visibility — separate
// namespace so disabling something on the web doesn't accidentally
// disable it on mobile (and vice versa).
//
// The list of valid keys + their default-by-role values lives in
// ../../shared/permissions.js and is also imported by the web admin
// UI (StaffForm.jsx). Adding a new feature in that one file
// auto-flows here and to the parity linter (npm run check:mobile-parity).
//
// Default: off. A profile predating mobile feature flags has no
// permissions.mobile object, in which case every key returns false and
// the user lands on the Home tab with everything else hidden. They'll
// see "Ask an admin to enable mobile features" — a one-time onboarding
// nudge handled in app/(tabs)/index.jsx.

// Re-export the shared definitions so screens that need labels/hints
// (e.g. a future in-app notification preferences page) can import
// them from `../lib/permissions` instead of crossing the shared/
// boundary directly.
export {
  MOBILE_PERMISSIONS,
  MOBILE_PERMISSION_KEYS,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
} from '../../shared/permissions'

/**
 * @param {object|null|undefined} profile     The safe profile from /api/mobile/me
 * @param {string} key                         e.g. 'schedule', 'pipeline', 'whatsapp', 'notify_swap'
 * @returns {boolean}
 */
export function canMobile(profile, key) {
  if (!profile) return false
  const m = profile.permissions?.mobile
  if (!m || typeof m !== 'object') return false
  return m[key] === true
}

/**
 * Returns true if any mobile feature is enabled. Used to decide whether
 * to show the empty-state "ask an admin" nudge on Home.
 */
export function hasAnyMobileFeature(profile) {
  const m = profile?.permissions?.mobile
  if (!m || typeof m !== 'object') return false
  return Object.values(m).some(v => v === true)
}
