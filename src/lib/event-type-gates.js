// ROLEUI.1 — may the caller edit or delete a booking type (event_types row)?
//
// The decision /api/bookings/event-types/[id] (DELETE; the UI never calls
// its PUT) and /api/bookings/event-types/[id]/reminders (the edit form's
// reminder sync) make for a cookie caller (ROLESWEEP.2): a master passes;
// anyone else must belong to the row's location and hold MANAGER_ROLES
// there. The edit form itself writes event_types with the BROWSER client,
// which RLS admits for any member (C39 EVENTTYPERLS.1). The pages that show
// Edit and Delete ask this, never user.role (the ACTIVE studio's role), so a
// button shows exactly where those routes would act.
//
// Pure: no network, no next/headers. Safe in a server page.
import { hasRoleAtLocation } from './role-at-location'
import { MANAGER_ROLES } from './schemas'

/**
 * @param {object|null} user        getCurrentUser() result
 * @param {string|null} locationId  the event_types row's location_id
 * @returns {boolean}
 */
export function canManageEventType(user, locationId) {
  if (!user) return false
  if (user.isMaster) return true
  if (!locationId || !(user.locations || []).some((l) => l?.id === locationId)) return false
  return hasRoleAtLocation(user, locationId, MANAGER_ROLES)
}
