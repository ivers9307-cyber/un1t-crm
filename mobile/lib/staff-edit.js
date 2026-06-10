// Pure helper for the mobile staff role editor (Plan C2c-i). Builds the
// `assignments` array for a PUT /api/staff/[id] from the GET'd current
// assignment state + per-location role edits.
//
// SAFETY: the server treats body.assignments as the desired state and
// buildAssignmentRow defaults permissions→{} and unifi_door_access→false
// when a key is absent — so a partial payload WIPES a location's
// permissions or physical door access. This builder always echoes back
// each emitted assignment's permissions + unifi_door_access + is_default
// (changing only the role), and OMITS unifi_user_id / unifi_door_ids /
// ac_device_ids / protect_face_id so the server leaves those DB values
// unchanged (their hasOwnProperty-omit semantics).
//
// Master vs owner (mirrors computeDesiredAssignments): master sends the
// FULL set (a missing assignment would be deleted); owner sends ONLY
// owned-location assignments (the server preserves rows at locations the
// owner doesn't own — the owner must not send them).
//
// @param {object} p
// @param {boolean} p.isMaster
// @param {string[]} p.ownedLocationIds
// @param {object[]} p.currentAssignments  GET'd profile_locations rows
// @param {Record<string,string>} p.roleEdits  location_id → new role
// @returns {object[]} assignments payload
export function buildStaffAssignmentsPatch({ isMaster, ownedLocationIds, currentAssignments, roleEdits }) {
  const owned = new Set(ownedLocationIds || [])
  const edits = roleEdits || {}
  const out = []
  for (const pl of (currentAssignments || [])) {
    if (!isMaster && !owned.has(pl.location_id)) continue // owner: server preserves non-owned
    out.push({
      location_id: pl.location_id,
      role: edits[pl.location_id] || pl.role,
      is_default: pl.is_default,
      permissions: pl.permissions || {},
      unifi_door_access: pl.unifi_door_access,
    })
  }
  return out
}
