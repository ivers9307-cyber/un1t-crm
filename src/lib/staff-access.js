// Access-control helpers for the staff-management surface.
//
// Two named helpers used by /settings/staff/[id]/page.js and
// LocationFeatures rendering:
//
//   canEditStaffMember(caller, target)
//     Tightened from the pre-audit "any owner can edit anyone" rule:
//       - Master: can edit everyone (incl. other masters, themselves)
//       - Owner:  can NOT edit themselves
//                 can NOT edit any profile whose `role === 'owner'`
//                 can edit manager / head_coach / staff at their
//                 owner-locations
//       - Anyone else: cannot use the staff editor at all (the
//                      page-level redirect catches this; the helper
//                      returns false for completeness)
//
//   canEditLocationFeatures(caller)
//     Per-location feature toggles affect every user at the
//     location, including the owner. Restricted to master so a
//     studio owner can't accidentally turn off someone else's
//     critical feature without master sign-off.
//
// Both helpers are pure — drive them with a `caller` (getCurrentUser
// shape) and a `target` (profile row with at least `id` and `role`).
// All page guards + UI hides should call these instead of reinventing
// the rule each time.

/**
 * Map a profile_locations row from the API into the shape the
 * StaffForm component expects, INCLUDING the permissions blob.
 *
 * Lives here so the bug where `permissions` was silently dropped
 * during the load (causing the form to render role defaults and the
 * operator's saves to look like they evaporated on refresh) can't
 * recur — adding a new field on the assignment row only requires
 * updating this single shape.
 *
 * @param {object} pl  profile_locations row
 * @returns {{ location_id, role, is_default, unifi_door_access, permissions }}
 */
export function mapProfileLocationToAssignment(pl) {
  if (!pl) return null
  return {
    location_id: pl.location_id,
    role: pl.role,
    is_default: !!pl.is_default,
    unifi_door_access: !!pl.unifi_door_access,
    // CRITICAL: keep the permissions blob. StaffForm's hydration
    // path (initialAssignments in StaffForm.jsx) only renders the
    // saved overrides when permissions has keys; an empty/undefined
    // blob falls back to role defaults, which is what made every
    // saved override look like it was wiped on refresh.
    permissions: pl.permissions || {},
  }
}

/**
 * @param {{ id, role, isMaster }} caller
 * @param {{ id, role }} target
 * @returns {boolean}
 */
export function canEditStaffMember(caller, target) {
  if (!caller || !target) return false
  // Master: full access.
  if (caller.isMaster || caller.role === 'master') return true
  // Non-owner: not in the editor at all.
  if (caller.role !== 'owner') return false
  // Owner editing themselves — denied.
  if (caller.id === target.id) return false
  // Owner editing another owner — denied. Master is the only role
  // that can promote/demote owner-level assignments.
  if (target.role === 'owner') return false
  return true
}

/**
 * @param {{ role, isMaster }} caller
 * @returns {boolean}
 */
export function canEditLocationFeatures(caller) {
  if (!caller) return false
  return caller.isMaster === true || caller.role === 'master'
}
