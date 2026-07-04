// Pure logic extracted from PUT /api/staff/[id] (Plan C2b.1). These
// functions have NO DB or network access — they're the testable core
// of the staff-update flow. The route still owns orchestration + the
// UniFi/DB side-effects (extracted in C2b.2). Each function reproduces
// the previously-inline behavior exactly; the characterization tests
// pin it.

import { OWNER_ASSIGNABLE_ROLES, MASTER_ASSIGNABLE_ROLES } from '@/lib/schemas'
import { diffPermissionsBlob, hydratePermissions, mergeTemplates } from '@shared/permissions'
import { splitCompFromProfilePatch, upsertCompensationForProfile } from '@/lib/profile-compensation'
import {
  getLocationUnifiConfig, findOrCreateUnifiUser,
  syncUnifiUserPolicyForRole, revokeUnifiUserPolicies, UnifiError,
} from '@/lib/unifi-access'

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

const ROLE_PRECEDENCE = { owner: 1, manager: 2, head_coach: 3, reception: 4, staff: 5 }

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

/** PERM-AUDIT.3 — reduce each assignment's permissions blob to the
 * SPARSE diff vs its effective role base (code defaults + the
 * location's role template, mig 364) before it hits the DB.
 *
 * This is what makes per-user permissions inherit again: a stored
 * blob only pins the keys an admin deliberately changed, so role
 * changes, role-template edits and future code-default changes all
 * flow through automatically. The editors keep sending FULL hydrated
 * blobs (their save shape is unchanged); the server owns the diff.
 *
 * Idempotent: an already-sparse blob diffs to itself. Non-boolean
 * extras riding on .mobile (layout, lead_time_overrides) are
 * preserved. The template fetch failing degrades to diffing against
 * code defaults only — worst case a few extra keys are stored, never
 * a lost override. */
export async function sparsifyAssignmentPermissions({ db, assignments, employmentType = null }) {
  const list = assignments || []
  const locIds = [...new Set(list.map(a => a.location_id).filter(Boolean))]
  let templates = []
  if (locIds.length > 0) {
    try {
      const { data } = await db
        .from('location_role_permissions')
        .select('location_id, role, employment_type, permissions')
        .in('location_id', locIds)
      templates = data || []
    } catch {
      templates = []
    }
  }
  // RECEPTION.2 (mig 367) — the diff base includes the target's
  // employment-type variant layered over the role's 'all' template,
  // matching exactly what the resolver will use for this user.
  const rowFor = (locId, role, emp) =>
    templates.find(t => t.location_id === locId && t.role === role && t.employment_type === emp)?.permissions || null
  const templateFor = (locId, role) =>
    mergeTemplates(
      rowFor(locId, role, 'all'),
      employmentType ? rowFor(locId, role, employmentType) : null
    )
  return list.map(a => ({
    ...a,
    permissions: diffPermissionsBlob(
      a.permissions || {},
      hydratePermissions(null, a.role, templateFor(a.location_id, a.role))
    ),
  }))
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

/** Sync a staff member's profile_locations to the desired-state list:
 * (1) revoke door policies + delete rows no longer desired, (2) insert
 * new / update existing rows with per-row UniFi door sync. Returns the
 * aggregated { unifiErrors } (the route surfaces them as a 502 without
 * rolling back the DB writes — they're independent per-location). Pure
 * mirror of the route's two inline loops. Uses applyDoorAccessChange +
 * buildAssignmentRow (same module) and the @/lib/unifi-access helpers. */
export async function syncStaffAssignments({ db, id, targetBefore, desired, desiredIds, existingByLocation }) {
  const unifiErrors = []

  // 1. Revoke + delete rows that are no longer in the desired set.
  for (const link of (targetBefore.profile_locations || [])) {
    if (desiredIds.has(link.location_id)) continue
    if (link.unifi_door_access && link.unifi_user_id && link.locations) {
      const cfg = getLocationUnifiConfig(link.locations)
      if (cfg.configured) {
        try {
          await revokeUnifiUserPolicies(cfg, link.unifi_user_id)
        } catch (e) {
          const msg = e instanceof UnifiError ? e.message : `UniFi revoke failed: ${e.message || e}`
          unifiErrors.push(`${link.locations.name}: ${msg}`)
        }
      }
    }
    await db.from('profile_locations')
      .delete()
      .eq('profile_id', id)
      .eq('location_id', link.location_id)
  }

  // 2. Insert new rows + update existing rows. UniFi sync happens
  //    as part of the iteration so we capture role + door-access
  //    intent in one pass.
  for (const a of desired) {
    const existing = existingByLocation[a.location_id]
    const wantsDoor = !!a.unifi_door_access

    // Do the UniFi sync against THIS location with the role this
    // user will have AT THIS location. Critically, the role is
    // a.role (per-location) — not profiles.role.
    let unifiUserId = existing?.unifi_user_id || null

    // Manual UniFi user link (mig 120 attendance picker). If the
    // assignment payload includes an explicit unifi_user_id key:
    //   - string  → set the link to that id (overrides the existing
    //               value AND skips findOrCreateUnifiUser, since the
    //               operator picked exactly which UniFi user to use)
    //   - null    → clear the link
    //   - missing → leave behaviour unchanged (auto-create on toggle)
    // This is what the staff edit page uses to attach a CRM profile
    // to a pre-existing UniFi user that doesn't share the email
    // findOrCreateUnifiUser would otherwise look up.
    const manualLinkProvided = Object.prototype.hasOwnProperty.call(a, 'unifi_user_id')
    if (manualLinkProvided) {
      unifiUserId = a.unifi_user_id || null
    }

    const locationRow = existing?.locations
    if (locationRow) {
      try {
        unifiUserId = await applyDoorAccessChange({
          profile: targetBefore,
          location: locationRow,
          enable: wantsDoor,
          role: a.role,
          existingUnifiUserId: unifiUserId,
          // When the operator manually picked a specific UniFi user,
          // skip the find-or-create lookup — we want THIS user, not
          // whoever happens to share the staff member's email.
          skipFindOrCreate: manualLinkProvided && !!unifiUserId,
        })
      } catch (e) {
        const msg = e instanceof UnifiError
          ? e.message
          : `UniFi sync failed at ${locationRow.name || 'location'}: ${e.message || e}`
        unifiErrors.push(msg)
        // Don't apply the door toggle change for this location, but
        // DO still apply role + is_default change. The toggle stays
        // at its previous state so UI / DB / UniFi don't diverge.
      }
    } else if (manualLinkProvided) {
      // No location row joined (rare), but a manual link was set —
      // honour it without doing any UniFi calls.
      // unifiUserId already holds the manual value above.
    }

    const row = buildAssignmentRow({
      id,
      assignment: a,
      wantsDoor,
      unifiUserId,
      syncedAt: new Date().toISOString(),
    })

    if (existing) {
      await db.from('profile_locations')
        .update(row)
        .eq('profile_id', id)
        .eq('location_id', a.location_id)
    } else {
      await db.from('profile_locations').insert(row)
    }
  }

  return { unifiErrors }
}

// Apply a per-location door-access toggle. Returns the unifi_user_id
// that should be persisted on the profile_locations row (or null if
// nothing should change).
//
// Throws UnifiError on failure — the caller surfaces the message to
// the API consumer without persisting the toggle change in
// profile_locations, so the UI state stays consistent with reality.
export async function applyDoorAccessChange({ profile, location, enable, role, existingUnifiUserId, skipFindOrCreate = false }) {
  const cfg = getLocationUnifiConfig(location)

  if (!enable) {
    if (cfg.configured && existingUnifiUserId) {
      await revokeUnifiUserPolicies(cfg, existingUnifiUserId)
    }
    return existingUnifiUserId || null
  }

  // Toggle ON requires a fully-configured UniFi instance for THIS location.
  if (!cfg.configured) {
    throw new UnifiError(
      `UniFi Access is not configured for ${location.name || 'this location'}. ` +
      `Add the host, API token and policy IDs in Location settings before ` +
      `enabling door access here.`
    )
  }
  // skipFindOrCreate=true → operator picked the UniFi user manually
  // via the staff edit picker (mig 120). Use the id they chose without
  // looking up by email or creating a new UniFi user. existingUnifiUserId
  // is already the operator-picked value at this point.
  const unifiUserId = existingUnifiUserId
    || (skipFindOrCreate ? null : await findOrCreateUnifiUser(cfg, profile))
  if (!unifiUserId) {
    throw new UnifiError('No UniFi user id available to sync policies for — pick a UniFi user in the staff edit page or rely on the auto-create flow.')
  }
  await syncUnifiUserPolicyForRole(cfg, unifiUserId, role)
  return unifiUserId
}
