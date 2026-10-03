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

/**
 * C138 (a) — who may upload template media (the sign + finalise routes) for a
 * studio: whoever may manage its templates (above), or master / owner there,
 * the card-set editor's rule (PUT /api/whatsapp/card-sets, guardMasterOrOwner):
 * the integrations tab uploads card images through the same two routes. The
 * routes judged membership only, so any staff member could put files in the
 * public bucket and push media to Meta on the studio's number. No studio
 * fails closed.
 *
 * @param {object|null} user
 * @param {string|null|undefined} locationId the studio uploaded for
 * @returns {boolean}
 */
export function canUploadWaTemplateMediaAt(user, locationId) {
  if (!user || !locationId) return false
  return canManageWaTemplatesAt(user, locationId) || hasRoleAtLocation(user, locationId, ['owner'])
}
