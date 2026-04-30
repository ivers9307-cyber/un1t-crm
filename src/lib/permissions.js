// Server-side permission helper — single function shared by every
// page-level permission gate.
//
// Resolution order:
//   1. permissions[key] explicitly === true → granted
//   2. permissions[key] explicitly === false → denied
//   3. permissions[key] undefined → fall back to the role default
//      defined in shared/permissions.js
//
// Owners are NOT special-cased here — if an owner toggles a feature
// off on their own profile, the toggle is honoured. Privileged
// admin actions (staff edit, branding upload, etc.) remain owner-
// only via separate `if (user.role !== 'owner') ...` checks inside
// those specific routes.

import { DEFAULT_WEB_PERMISSIONS_BY_ROLE } from '@shared/permissions'

/**
 * @param {{role: string, permissions?: object} | null | undefined} user
 * @param {string} key  e.g. 'dashboard_personal', 'pipeline', 'settings'
 * @returns {boolean}
 */
export function hasPermission(user, key) {
  if (!user) return false
  const perms = user.permissions || {}
  if (key in perms) return perms[key] === true
  return DEFAULT_WEB_PERMISSIONS_BY_ROLE[user.role]?.[key] === true
}
