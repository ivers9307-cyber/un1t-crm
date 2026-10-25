// MIAROLE.1 (C80) — who may change Mia's settings (PUT
// /api/settings/customer-agent): an OWNER at that studio, or a master. The
// owner decided this on 30 Sep 2026; before it, head coaches and managers
// could switch her on, off or into test mode.
//
// One predicate for the route's gate and the editor's controls, so the page
// can never offer a Save the server refuses (or hide one it would accept).
// Client-safe: role-at-location.js touches no network, headers or database.

import { hasRoleAtLocation } from '@/lib/role-at-location'

export const MIA_SETTINGS_EDIT_ROLES = Object.freeze(['owner'])

/**
 * @param {{ profileRole?: string, rolesByLocation?: Record<string,string> } | null} user
 * @param {string | null | undefined} locationId  the studio whose settings change
 * @returns {boolean}  master bypass on profileRole; fails closed on no user/location
 */
export function canEditMiaSettings(user, locationId) {
  return hasRoleAtLocation(user, locationId, MIA_SETTINGS_EDIT_ROLES)
}
