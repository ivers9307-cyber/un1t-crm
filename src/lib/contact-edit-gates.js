// ORGCONTACTS.4 (decision 4, spec 2026-10-20 §5) — edit rights on a contact
// that several studios of one organisation share. Pure.
//
//   canEditContact — EDIT ANYWHERE the person has a relationship: a master, or
//     MANAGER_ROLES at the contact's primary studio (today's rule, unchanged),
//     or MANAGER_ROLES at a studio in `relationshipStudioIds` (their
//     contact_studios rows, any status) where the caller also holds Contacts.
//     The role bar is unchanged: the decision widens WHERE, not WHO.
//   canDeleteOrRehomeContact — DELETE and CHANGE PRIMARY STUDIO stay with the
//     primary studio's admins (MANAGER_ROLES there), an organisation admin of
//     the contact's organisation, or a master.
//
// A contact with no primary studio admits nobody, a master included (the
// routes answer 404 / 403 for it, as before). `relationshipStudioIds` may be
// omitted (an unreadable rows read): then only the primary rule applies.
import { hasRoleAtLocation } from './role-at-location'
import { hasPermissionForLocation } from './permissions'
import { isOrgAdmin } from './org-admin'
import { MANAGER_ROLES } from './schemas'

const isMaster = (user) => Boolean(user && (user.isMaster || user.role === 'master'))
const memberOf = (user, locationId) => (user?.locations || []).some((l) => l?.id === locationId)
const managerAt = (user, locationId) => memberOf(user, locationId) && hasRoleAtLocation(user, locationId, MANAGER_ROLES)

/**
 * @param {{ user: object|null, contact: { location_id?: string|null }|null, relationshipStudioIds?: string[] }} args
 * @returns {boolean}
 */
export function canEditContact({ user, contact, relationshipStudioIds = [] } = {}) {
  const primary = contact?.location_id || null
  if (!user || !contact || !primary) return false
  if (isMaster(user)) return true
  if (managerAt(user, primary)) return true
  for (const loc of new Set((relationshipStudioIds || []).filter(Boolean))) {
    if (loc === primary) continue
    if (managerAt(user, loc) && hasPermissionForLocation(user, loc, 'contacts')) return true
  }
  return false
}

/**
 * @param {{ user: object|null, contact: { location_id?: string|null, organization_id?: string|null }|null }} args
 * @returns {boolean}
 */
export function canDeleteOrRehomeContact({ user, contact } = {}) {
  const primary = contact?.location_id || null
  if (!user || !contact || !primary) return false
  if (isMaster(user)) return true
  if (managerAt(user, primary)) return true
  return isOrgAdmin(user, contact.organization_id || null)
}
