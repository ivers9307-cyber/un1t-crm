import {
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
} from '../../shared/permissions'

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
// @param {object} p
// @param {boolean} p.isMaster
// @param {string[]} p.ownedLocationIds
// @param {object[]} p.currentAssignments  GET'd profile_locations rows
// @param {Record<string,string>} [p.roleEdits]  location_id → new role
// @param {Record<string,object>} [p.permissionEdits]  location_id → full permissions blob
// @returns {object[]} assignments payload
export function buildStaffAssignmentsPatch({ isMaster, ownedLocationIds, currentAssignments, roleEdits, permissionEdits }) {
  const owned = new Set(ownedLocationIds || [])
  const roles = roleEdits || {}
  const perms = permissionEdits || {}
  const out = []
  for (const pl of (currentAssignments || [])) {
    if (!isMaster && !owned.has(pl.location_id)) continue // owner: server preserves non-owned
    out.push({
      location_id: pl.location_id,
      role: roles[pl.location_id] || pl.role,
      is_default: pl.is_default,
      permissions: perms[pl.location_id] || pl.permissions || {},
      unifi_door_access: pl.unifi_door_access,
    })
  }
  return out
}

// Hydrate a per-assignment permissions blob for display in the editor —
// mirrors src/components/StaffForm.jsx's initialAssignments logic so the
// mobile toggles render the SAME truth as web. A non-empty stored blob is
// used as-is, with its `.mobile` sub-object filled from role defaults when
// absent; an empty {} (the "use role defaults" sentinel) becomes the
// role's full web+mobile default blob. The result is a FULL blob safe to
// edit and send back — sparse web keys are intentionally NOT back-filled
// (web doesn't either), preserving identical behaviour across platforms.
//
// @param {object|null|undefined} rawPermissions  the stored permissions blob
// @param {string} role  the assignment's per-location role
// @returns {object} a full { ...web, mobile: { ...mobile } } blob
export function hydratePermissions(rawPermissions, role) {
  const web = DEFAULT_WEB_PERMISSIONS_BY_ROLE[role] || {}
  const mob = DEFAULT_MOBILE_PERMISSIONS_BY_ROLE[role] || {}
  const raw = rawPermissions || {}
  if (Object.keys(raw).length > 0) {
    return { ...raw, mobile: { ...(raw.mobile || mob) } }
  }
  return { ...web, mobile: { ...mob } }
}
