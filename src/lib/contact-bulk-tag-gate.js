// CONTACTTAGS.1 — who may bulk-tag at a studio. Server-side (the contacts
// list page and POST /api/contacts/bulk-tags); kept out of
// contact-manual-tags.js so the client bundle never pulls schemas.js.
import { hasRoleAtLocation } from './role-at-location'
import { hasPermissionForLocation } from './permissions'
import { MANAGER_ROLES } from './schemas'

/**
 * POST /api/contacts/bulk-tags, and the list's bulk Tag buttons: a master, or
 * MANAGER_ROLES at the studio (as a member of it) with Contacts there. The
 * role bar is PUT /api/contacts/[id]'s (an edit of the contact); Contacts is
 * what lets the caller read the studio's contacts at all.
 */
export function canBulkTagAt(user, locationId) {
  if (!user || !locationId) return false
  if (user.isMaster || user.role === 'master') return true
  const member = (user.locations || []).some((l) => l?.id === locationId)
  if (!member) return false
  return hasRoleAtLocation(user, locationId, MANAGER_ROLES) && hasPermissionForLocation(user, locationId, 'contacts')
}
