// C120 GATES-3 (b) — who may create, edit, resubmit or delete a WhatsApp
// template at a studio, judged at THAT studio (the template's, or the one it
// is created at): MANAGER_ROLES there (WATPLROLE.1) AND the `whatsapp`
// permission there. The routes judged the role only, so a manager with
// WhatsApp switched off at the studio could still submit, change and delete
// its templates at Meta. The routes and the pages that offer those actions
// share this one rule. Server or client safe (no IO).
import { hasRoleAtLocation } from './role-at-location'
import { hasPermissionForLocation } from './permissions'
import { MANAGER_ROLES } from './schemas'

/**
 * @param {object|null} user               getCurrentUser() result
 * @param {string|null|undefined} locationId the template's studio
 * @returns {boolean}
 */
export function canManageWaTemplatesAt(user, locationId) {
  if (!user || !locationId) return false
  return hasRoleAtLocation(user, locationId, MANAGER_ROLES)
    && hasPermissionForLocation(user, locationId, 'whatsapp')
}
