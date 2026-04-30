// Mobile permissions helper.
//
// On the web, permissions.<key> controls sidebar visibility. On mobile,
// permissions.mobile.<key> controls tab/screen visibility — separate
// namespace so disabling something on the web doesn't accidentally
// disable it on mobile (and vice versa).
//
// Default: off. A profile predating mobile feature flags has no
// permissions.mobile object, in which case every key returns false and
// the user lands on the Home tab with everything else hidden. They'll
// see "Ask an admin to enable mobile features" — a one-time onboarding
// nudge handled in app/(tabs)/index.jsx.

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
