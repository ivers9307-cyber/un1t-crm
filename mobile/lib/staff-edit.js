import { hydratePermissions } from 'shared/permissions'

// Pure helpers for the mobile staff editors — the role editor (Plan
// C2c-i) and the permissions editor (Plan C2c-ii). Builds the
// `assignments` array for a PUT /api/staff/[id] from the GET'd current
// assignment state + per-location role and/or permission edits.
//
// SAFETY: the server treats body.assignments as the desired state and
// buildAssignmentRow defaults permissions→{} and unifi_door_access→false
// when a key is absent — so a partial payload WIPES a location's
// permissions or physical door access. This builder always echoes back
// each emitted assignment's permissions + unifi_door_access + is_default
// (changing only role and/or permissions where edited), and OMITS
// unifi_user_id / unifi_door_ids / ac_device_ids / protect_face_id so the
// server leaves those DB values unchanged (their hasOwnProperty-omit
// semantics).
//
// Permission edits carry the FULL hydrated blob for a touched location
// (see hydratePermissions) — a partial blob would wipe absent keys. Only
// touched locations belong in permissionEdits; an untouched editable
// location echoes its raw permissions, so nothing is frozen or wiped.
//
// Master vs owner (mirrors computeDesiredAssignments): master sends the
// FULL set (a missing assignment would be deleted); owner sends ONLY
// owned-location assignments (the server preserves rows at locations the
// owner doesn't own — the owner must not send them). The owner boundary
// applies to permission edits too: a non-owned location is skipped
// entirely, so a permissionEdits entry for it can never reach the server.
//
// Add/remove (C3-wizard.2): removedLocationIds OMITS those assignments
// from the payload so the server deletes them (and revokes door access);
// addedAssignments APPENDS new studios. The owner boundary applies to
// BOTH — a removed/added non-owned location is skipped, so an owner can
// only add/remove at locations they own. removal of the default is safe:
// the server auto-promotes a remaining assignment to default.
//
// @param {object} p
// @param {boolean} p.isMaster
// @param {string[]} p.ownedLocationIds
// @param {object[]} p.currentAssignments  GET'd profile_locations rows
// @param {Record<string,string>} [p.roleEdits]  location_id → new role
// @param {Record<string,object>} [p.permissionEdits]  location_id → full permissions blob
// @param {string[]} [p.removedLocationIds]  location_ids to remove (omit → server deletes)
// @param {object[]} [p.addedAssignments]  new { location_id, role } studios to append
// @returns {object[]} assignments payload
export function buildStaffAssignmentsPatch({ isMaster, ownedLocationIds, currentAssignments, roleEdits, permissionEdits, removedLocationIds, addedAssignments }) {
  const owned = new Set(ownedLocationIds || [])
  const roles = roleEdits || {}
  const perms = permissionEdits || {}
  const removed = new Set(removedLocationIds || [])
  const out = []
  for (const pl of (currentAssignments || [])) {
    if (!isMaster && !owned.has(pl.location_id)) continue // owner: server preserves non-owned
    if (removed.has(pl.location_id)) continue             // omit a removed assignment → the server deletes it (+ revokes door)
    out.push({
      location_id: pl.location_id,
      role: roles[pl.location_id] || pl.role,
      is_default: pl.is_default,
      permissions: perms[pl.location_id] || pl.permissions || {},
      unifi_door_access: pl.unifi_door_access,
    })
  }
  // Newly-added studios. A new assignment starts at role defaults
  // (permissions {} → role default applies) with door access off; the
  // server normalises a single is_default and auto-promotes one if the
  // removed assignment was the default.
  for (const a of (addedAssignments || [])) {
    if (!a || !a.location_id) continue
    if (!isMaster && !owned.has(a.location_id)) continue  // owner can only add at owned locations
    if (removed.has(a.location_id)) continue              // add+remove the same location → no-op
    if ((currentAssignments || []).some(pl => pl.location_id === a.location_id)) continue // already assigned → never duplicate
    out.push({
      location_id: a.location_id,
      role: a.role,
      is_default: false,
      permissions: a.permissions || {},
      unifi_door_access: false,
    })
  }
  return out
}

// Hydrate a per-assignment permissions blob for display in the editor.
// The canonical implementation lives in shared/permissions.js (also used
// by web's StaffForm.jsx, so both editors render the SAME truth): role
// defaults are merged UNDER the stored blob for BOTH the flat web keys
// and the `.mobile` sub-object — stored explicit values always win,
// missing keys show their role-default effective value (PR #754 Q1).
// Re-exported here so the permissions editor + existing callers keep
// their import path.
export { hydratePermissions }
