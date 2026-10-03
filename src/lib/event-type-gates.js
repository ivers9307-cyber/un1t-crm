// ROLEUI.1 — may the caller edit or delete a booking type (event_types row)?
// EVENTTYPERLS.1 — and may they create one at their active studio?
//
// The decision /api/bookings/event-types/[id] (PUT, DELETE),
// /api/bookings/event-types (POST, the cookie branch) and
// /api/bookings/event-types/[id]/reminders make for a cookie caller: a master
// passes; anyone else must belong to the row's (or the new row's) location
// and hold MANAGER_ROLES there. Since EVENTTYPERLS.1 those routes are the
// ONLY writers of event_types (the form used to write with the browser
// client, which RLS admitted for any member; mig 650 removes that). The pages
// that show Edit, Delete and New ask this, never user.role (the ACTIVE
// studio's role), so a button shows exactly where those routes would act.
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

/**
 * EVENTTYPERLS.1 — may the caller create a booking type where
 * /bookings/event-types/new creates it (their ACTIVE studio, the location_id
 * the form sends)? POST /api/bookings/event-types needs a location, so no
 * active studio is a no, even for a master.
 *
 * @param {object|null} user  getCurrentUser() result
 * @returns {boolean}
 */
export function canCreateEventType(user) {
  const locationId = user?.activeLocation?.id
  return !!locationId && canManageEventType(user, locationId)
}
