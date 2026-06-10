// Pure logic extracted from PUT /api/staff/[id] (Plan C2b.1). These
// functions have NO DB or network access — they're the testable core
// of the staff-update flow. The route still owns orchestration + the
// UniFi/DB side-effects (extracted in C2b.2). Each function reproduces
// the previously-inline behavior exactly; the characterization tests
// pin it.

import { OWNER_ASSIGNABLE_ROLES, MASTER_ASSIGNABLE_ROLES } from '@/lib/schemas'
import { splitCompFromProfilePatch, upsertCompensationForProfile } from '@/lib/profile-compensation'

const PROFILE_PATCH_KEYS = [
  'full_name', 'permissions', 'active', 'employment_type',
  'annual_salary', 'hourly_rate', 'contracted_hours_per_week',
  'annual_leave_entitlement', 'overtime_rate',
]

/** Build the profiles update patch from a validated body — only keys
 * actually present (undefined keys are skipped; null/false are kept). */
export function buildStaffProfilePatch(body) {
  const patch = {}
  for (const key of PROFILE_PATCH_KEYS) {
    if (body[key] !== undefined) patch[key] = body[key]
  }
  return patch
}

const ROLE_PRECEDENCE = { owner: 1, manager: 2, head_coach: 3, staff: 4 }

/** Recompute profiles.role: master flag wins, else the highest-
 * precedence role across the current assignments, else the fallback. */
export function computeProfileRole({ isMaster, assignmentRoles, fallbackRole }) {
  if (isMaster) return 'master'
  const highest = [...(assignmentRoles || [])]
    .sort((a, b) => (ROLE_PRECEDENCE[a] || 99) - (ROLE_PRECEDENCE[b] || 99))[0]
  return highest || fallbackRole || 'staff'
}

/** Owner/master assignment-scope authorization. Returns null when
 * allowed, or { status, error } to return from the route. Pure mirror
 * of the inline guard (route ~lines 165-207). */
export function assertOwnerAssignmentScope({ isMaster, callerOwnerLocationIds, targetLocationIds, assignments }) {
  if (!isMaster) {
    const owned = new Set(callerOwnerLocationIds || [])
    const overlap = (targetLocationIds || []).some(l => owned.has(l))
    if (!overlap) {
      return { status: 403, error: 'You can only edit staff assigned to a location where you are an owner.' }
    }
    if (assignments) {
      for (const a of assignments) {
        if (!owned.has(a.location_id)) {
          return { status: 403, error: 'You can only manage assignments at locations where you are an owner.' }
        }
        if (!OWNER_ASSIGNABLE_ROLES.includes(a.role)) {
          return { status: 403, error: `Role '${a.role}' cannot be granted by an owner.` }
        }
      }
    }
    return null
  }
  if (assignments) {
    for (const a of assignments) {
      if (!MASTER_ASSIGNABLE_ROLES.includes(a.role)) {
        return { status: 403, error: `Role '${a.role}' is not a valid per-location role.` }
      }
    }
  }
  return null
}

/** Compute the FULL desired-state assignment list from the request.
 * Master → the body verbatim. Owner → body rows at owned locations,
 * plus every existing row at a NON-owned location preserved verbatim
 * (role, is_default, door access, and the permissions blob — mig 058).
 * Then normalise to exactly one is_default. Pure mirror of route lines
 * 285-322.
 *
 * NOTE: in the master path the body `assignments` objects are pushed by
 * reference, so the single-default normalisation below can mutate
 * `assignments[i].is_default` in place (matching the original inline
 * route behaviour). Callers should not reuse the input array afterward
 * expecting it untouched. */
export function computeDesiredAssignments({ isMaster, callerOwnerLocationIds, assignments, existingLinks }) {
  const links = existingLinks || []
  const desired = []
  if (isMaster) {
    for (const a of assignments) desired.push(a)
  } else {
    const owned = new Set(callerOwnerLocationIds || [])
    for (const a of assignments) {
      if (owned.has(a.location_id)) desired.push(a)
    }
    for (const link of links) {
      if (!owned.has(link.location_id)) {
        desired.push({
          location_id: link.location_id,
          role: link.role,
          is_default: link.is_default,
          unifi_door_access: link.unifi_door_access,
          permissions: link.permissions || {},
        })
      }
    }
  }

  if (desired.length > 0 && !desired.some(a => a.is_default)) {
    desired[0].is_default = true
  }
  let seenDefault = false
  for (const a of desired) {
    if (a.is_default) {
      if (seenDefault) a.is_default = false
      else seenDefault = true
    }
  }
  return desired
}

/** Build the profile_locations row for one desired assignment. PURE —
 * the synced-at timestamp + the per-location UniFi user id are injected
 * (the route does the UniFi sync, this just shapes the DB row). Pure
 * mirror of route lines ~294-328.
 *
 * Optional-key semantics (all mirror unifi_user_id's null/string/omit):
 *   - protect_face_id (mig 142): string sets, null clears, omit leaves
 *     the DB value unchanged (key omitted from the row).
 *   - unifi_door_ids (mig 182) / ac_device_ids (mig 210): null clears,
 *     [] = empty allowlist, array = exactly those, omit leaves the DB
 *     value unchanged (key omitted). */
export function buildAssignmentRow({ id, assignment, wantsDoor, unifiUserId, syncedAt }) {
  const a = assignment
  return {
    profile_id: id,
    location_id: a.location_id,
    role: a.role,
    is_default: !!a.is_default,
    unifi_door_access: wantsDoor,
    unifi_synced_at: syncedAt,
    unifi_user_id: unifiUserId,
    permissions: a.permissions || {},
    ...(Object.prototype.hasOwnProperty.call(a, 'protect_face_id')
      ? { protect_face_id: a.protect_face_id || null } : {}),
    ...(Object.prototype.hasOwnProperty.call(a, 'unifi_door_ids')
      ? { unifi_door_ids: a.unifi_door_ids === null ? null : (a.unifi_door_ids || []) } : {}),
    ...(Object.prototype.hasOwnProperty.call(a, 'ac_device_ids')
      ? { ac_device_ids: a.ac_device_ids === null ? null : (a.ac_device_ids || []) } : {}),
  }
}

/** Apply the profile-level update + the compensation dual-write
 * (SECURITY.1 / mig 152) for a staff PUT. Writes buildStaffProfilePatch(body)
 * to `profiles`, then the 5 comp fields to `profile_compensation`
 * (undefined skipped, null clears). Pure mirror of route lines ~190-215.
 * Returns { ok:true } or { ok:false, error } — the route maps a failure
 * to a 400. NO UniFi/door-access here (that's a later increment). */
export async function applyStaffProfileWrite({ db, id, body, actorId }) {
  const profileUpdates = buildStaffProfilePatch(body)
  if (Object.keys(profileUpdates).length > 0) {
    const { error } = await db.from('profiles').update(profileUpdates).eq('id', id)
    if (error) return { ok: false, error: error.message }
  }

  const { compFields } = splitCompFromProfilePatch({
    annual_salary:             body.annual_salary,
    hourly_rate:               body.hourly_rate,
    contracted_hours_per_week: body.contracted_hours_per_week,
    annual_leave_entitlement:  body.annual_leave_entitlement,
    overtime_rate:             body.overtime_rate,
  })
  const cleanComp = Object.fromEntries(
    Object.entries(compFields).filter(([, v]) => v !== undefined)
  )
  if (Object.keys(cleanComp).length > 0) {
    const compResult = await upsertCompensationForProfile(db, id, cleanComp, { actorId })
    if (!compResult.ok) return { ok: false, error: `compensation: ${compResult.error}` }
  }
  return { ok: true }
}
