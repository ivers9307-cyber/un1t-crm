// Server-side permission helper — single function shared by every
// page-level permission gate.
//
// Three-tier resolution:
//   1. LOCATION gate (migration 032) — if the user's active location
//      has features[key] === false, the answer is DENIED regardless
//      of role or per-user override. Notification preferences
//      (notify_*) are exempt from this gate (see
//      isFeatureGatedByLocation in shared/permissions.js).
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
// Master role: honours the location gate just like everyone else
// (otherwise "disabled at this location" wouldn't really mean
// disabled). The single exception is the `settings` key — master
// always sees the Settings sidebar entry as an escape hatch so they
// can navigate to /settings/locations/[id] to flip features back on.
// Without that, a master at a location with settings turned off
// would have no way back into the per-location feature toggles
// from the sidebar. Once tier-1 passes, master also bypasses tiers
// 2 + 3 — no point making a master tick boxes for themselves once
// the location says yes.
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

  // Master escape hatch — Settings sidebar entry stays visible
  // unconditionally so a master can always navigate to the
  // per-location feature toggles. The route itself is master+owner
  // gated inside the page handler.
  if (user.role === 'master' && key === 'settings') return true

  // Tier 1: location gate. Applies to ALL roles including master.
  if (!isFeatureEnabledAtLocation(user.activeLocation, key)) return false

  // Master bypasses per-user permission tiers — once the location
  // says yes, master sees it without needing role-default or
  // per-user permission entries.
  if (user.role === 'master') return true

  // Tier 2: user override.
  const perms = user.permissions || {}
  if (key in perms) return perms[key] === true

  // Tier 3: role default.
  return DEFAULT_WEB_PERMISSIONS_BY_ROLE[user.role]?.[key] === true
}
