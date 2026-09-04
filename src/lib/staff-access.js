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
//                 can edit manager / head_coach / staff AT A LOCATION
//                 THE CALLER OWNS
//       - Anyone else: cannot use the staff editor at all (the
//                      page-level redirect catches this; the helper
//                      returns false for completeness)
//
//     STAFF-EDIT-RULE.1 — that last clause used to be a LIE. The doc
//     said "at their owner-locations" but the code only asked
//     `caller.role === 'owner'`, which is the caller's role at their
//     ACTIVE location, and never looked at locations at all. So it
//     answered wrongly in both directions: an owner at Stillorgan who
//     is plain staff at Hatch passed for a Hatch-only target (the
//     write was then refused deeper, by assertOwnerAssignmentScope in
//     staff-write.js — the real boundary), while an owner AT the
//     target's studio whose ACTIVE studio was elsewhere was refused a
//     record entirely theirs. It now asks the question the doc always
//     claimed, so the helper agrees with the boundary instead of
//     leaning on it. `target.locationIds` is therefore REQUIRED: a
//     caller that omits it gets `false`, which fails closed.
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
 * @returns {{ location_id, role, is_default, unifi_door_access, unifi_user_id, unifi_door_ids, geofence_exempt, permissions }}
 */
export function mapProfileLocationToAssignment(pl) {
  if (!pl) return null
  return {
    location_id: pl.location_id,
    role: pl.role,
    is_default: !!pl.is_default,
    unifi_door_access: !!pl.unifi_door_access,
    // Surfaced so the staff edit UniFi user picker (mig 120) can show
    // which UniFi user is currently linked — that link is what door
    // provisioning and offboarding revocation target. Empty/null =
    // unlinked.
    unifi_user_id: pl.unifi_user_id || null,
    // UNIFI-DOORS-SCOPE (mig 182) — per-location door allowlist.
    // Hydrated as an array so the form's multi-select renders the
    // current selection. NULL from the DB (legacy fallback for
    // manager+ roles after mig 182 backfill) surfaces here as null,
    // which the form treats as "all doors" mode. An empty array
    // means "no doors visible".
    unifi_door_ids: Array.isArray(pl.unifi_door_ids) ? pl.unifi_door_ids : (pl.unifi_door_ids ?? null),
    // STUDIO-AC-DEVICES.1 (mig 210) — per-location AC device
    // allowlist. Same null/empty/populated semantics as
    // unifi_door_ids: NULL surfaces as `null` and the dispatcher
    // treats it as "all devices" for manager+; an empty array
    // is the strict-opt-in default for staff/head_coach/contractor
    // after the mig 210 backfill; a populated array means exactly
    // those devices.
    ac_device_ids: Array.isArray(pl.ac_device_ids) ? pl.ac_device_ids : (pl.ac_device_ids ?? null),
    // GEO-ATT (mig 463) — mobile geofence attendance opt-out. Seeded
    // so the StaffForm toggle renders the stored state and the PUT
    // round-trips it (the form always sends the key).
    geofence_exempt: !!pl.geofence_exempt,
    // CRITICAL: keep the permissions blob. StaffForm's hydration
    // path (initialAssignments in StaffForm.jsx) only renders the
    // saved overrides when permissions has keys; an empty/undefined
    // blob falls back to role defaults, which is what made every
    // saved override look like it was wiped on refresh.
    permissions: pl.permissions || {},
  }
}

/**
 * @param {{ id, role, isMaster, profileRole?, rolesByLocation? }} caller
 * @param {{ id, role, locationIds?: string[] }} target — locationIds is every
 *   location the target is assigned to. REQUIRED for a non-master caller;
 *   omitting it denies (fail closed).
 * @returns {boolean}
 */
export function canEditStaffMember(caller, target) {
  if (!caller || !target) return false
  // Master: full access.
  if (caller.isMaster || caller.profileRole === 'master' || caller.role === 'master') return true
  // Owner editing themselves — denied.
  if (caller.id === target.id) return false
  // Owner editing another owner — denied. Master is the only role
  // that can promote/demote owner-level assignments.
  if (target.role === 'owner') return false
  // …and the caller must be an OWNER AT one of the target's locations —
  // not merely an owner somewhere. rolesByLocation is the per-location
  // truth; `caller.role` is the ACTIVE-location role and answers a
  // different question (see the header).
  const ownerLocationIds = Object.entries(caller.rolesByLocation || {})
    .filter(([, r]) => r === 'owner')
    .map(([loc]) => loc)
  if (ownerLocationIds.length === 0) return false
  const targetLocationIds = target.locationIds || []
  // A target assigned NOWHERE is nobody's to edit: assertOwnerAssignmentScope
  // (staff-write.js) already refuses that write for an owner, so answering
  // true here would only offer a form the server rejects. Master can still
  // reach an unassigned profile and give it a home.
  return targetLocationIds.some(id => ownerLocationIds.includes(id))
}

/**
 * AUTH.1 hardening — who may reset a STAFF member's password via
 * /api/admin/password-override.
 *
 * Pre-fix the route gated on role alone (`master` or `owner`) and never
 * checked the relationship between caller and target, so any owner at
 * any location could reset ANY staff/owner/master account by id — a
 * cross-org account-takeover path. This tightens it to:
 *
 *   - Master:  may reset anyone.
 *   - Owner:   may reset a manager / head_coach / staff member who
 *              shares at least one of the owner's locations. May NOT
 *              reset themselves, another owner (peer), or a master.
 *   - Anyone else: denied (the route's role gate already blocks them;
 *              this returns false for completeness).
 *
 * Pure helper — `target.role` is the target's EFFECTIVE role
 * ('master' | 'owner' | 'manager' | 'head_coach' | 'staff'), and
 * `target.locationIds` is every location the target is assigned to.
 *
 * @param {{ id, role, isMaster, locations?: Array<{id:string}> }} caller
 * @param {{ id, role, locationIds?: string[] }} target
 * @returns {boolean}
 */
export function canOverrideStaffPassword(caller, target) {
  if (!caller || !target) return false
  if (caller.isMaster || caller.role === 'master') return true
  if (caller.role !== 'owner') return false
  // Only a master may reset another master's password.
  if (target.role === 'master') return false
  // Reuse the staff-editor rule — blocks owner→self, owner→peer-owner, and
  // (since STAFF-EDIT-RULE.1) any target the caller does not OWN a location
  // with. locationIds must be forwarded or that last clause fails closed.
  if (!canEditStaffMember(caller, {
    id: target.id, role: target.role, locationIds: target.locationIds || [],
  })) return false
  // Owner may only reset staff who share one of the owner's locations.
  const callerLocs = (caller.locations || []).map((l) => l.id)
  const targetLocs = target.locationIds || []
  return targetLocs.some((id) => callerLocs.includes(id))
}

/**
 * @param {{ role, isMaster }} caller
 * @returns {boolean}
 */
export function canEditLocationFeatures(caller) {
  if (!caller) return false
  return caller.isMaster === true || caller.role === 'master'
}
