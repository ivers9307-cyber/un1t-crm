import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import {
  employmentTypeSchema, money, hours, days, permissionsSchema,
  assignmentSchema, OWNER_ASSIGNABLE_ROLES, MASTER_ASSIGNABLE_ROLES,
} from '@/lib/schemas'
import {
  getLocationUnifiConfig, findOrCreateUnifiUser,
  syncUnifiUserPolicyForRole, revokeUnifiUserPolicies, UnifiError,
} from '@/lib/unifi-access'
import { canEditStaffMember } from '@/lib/staff-access'

export const runtime = 'nodejs'

const UpdateStaffSchema = z.object({
  full_name: z.string().min(1).max(200).optional(),
  is_master: z.boolean().optional(),
  // The full per-location assignment set the user should have AFTER
  // this update. If omitted, assignments are left unchanged. If
  // provided, assignments diff against the existing rows — added
  // rows are inserted, removed rows are deleted (with UniFi revoke
  // if door access was on), updated rows have their role / unifi
  // toggle synced.
  assignments: z.array(assignmentSchema).optional(),
  permissions: permissionsSchema.optional(),
  active: z.boolean().optional(),
  employment_type: employmentTypeSchema.optional(),
  annual_salary: money.nullable().optional(),
  hourly_rate: money.nullable().optional(),
  contracted_hours_per_week: hours.nullable().optional(),
  annual_leave_entitlement: days.nullable().optional(),
  overtime_rate: money.nullable().optional(),
})

// Apply a per-location door-access toggle. Returns the unifi_user_id
// that should be persisted on the profile_locations row (or null if
// nothing should change).
//
// Throws UnifiError on failure — the caller surfaces the message to
// the API consumer without persisting the toggle change in
// profile_locations, so the UI state stays consistent with reality.
async function applyDoorAccessChange({ profile, location, enable, role, existingUnifiUserId }) {
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
  const unifiUserId = existingUnifiUserId
    || await findOrCreateUnifiUser(cfg, profile)
  await syncUnifiUserPolicyForRole(cfg, unifiUserId, role)
  return unifiUserId
}

// PUT /api/staff/[id] — Update a staff member.
//
// Authorization (mig 051):
//   master       → can edit any user, can grant/revoke master flag,
//                  can manage assignments at any location.
//   owner-at-X   → can edit users assigned to X, but ONLY their X
//                  assignment (not their other locations). Cannot
//                  grant/revoke master. Cannot mint another owner
//                  outside of X.
//
// The request's `assignments` array is the desired-state for the
// caller's REACHABLE subset of the user's assignments. Master
// gets the full set; owners only see/manipulate the assignments at
// their own locations.
export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!user.isMaster && user.role !== 'owner') {
    return NextResponse.json({
      success: false,
      error: 'Forbidden — must be an owner at this location (or a master) to edit staff',
    }, { status: 403 })
  }

  const { id } = params
  const validation = await validateBody(request, UpdateStaffSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Master-flag guard: only a master can grant or revoke master.
  if (body.is_master !== undefined && !user.isMaster) {
    return NextResponse.json({
      success: false,
      error: 'Only a master account can grant or revoke the master flag.',
    }, { status: 403 })
  }

  // Pull the target's existing assignments BEFORE any changes so we
  // can diff for UniFi revokes and authorization.
  const { data: targetBefore } = await db
    .from('profiles')
    .select('*, profile_locations(*, locations(*))')
    .eq('id', id)
    .single()

  if (!targetBefore) {
    return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 })
  }

  // Owner-self / owner-peer guard. Master is exempt. Defence-in-
  // depth — the UI page gate redirects before the form even
  // renders, but a hand-crafted PUT (n8n script, curl, etc.)
  // would otherwise bypass the rule.
  if (!canEditStaffMember(
    { id: user.id, role: user.role, isMaster: user.isMaster },
    { id: targetBefore.id, role: targetBefore.role },
  )) {
    return NextResponse.json({
      success: false,
      error: targetBefore.id === user.id
        ? 'Owners cannot edit their own permissions. Ask a master to make this change.'
        : 'Owners cannot edit other owners. Ask a master to make this change.',
    }, { status: 403 })
  }

  // Owners can only edit users they share a location with — and even
  // then only the assignments at locations where the caller is owner.
  if (!user.isMaster) {
    const callerOwnerLocations = new Set(
      Object.entries(user.rolesByLocation || {})
        .filter(([, r]) => r === 'owner')
        .map(([loc]) => loc)
    )
    const targetLocations = (targetBefore.profile_locations || []).map(l => l.location_id)
    const overlap = targetLocations.some(l => callerOwnerLocations.has(l))
    if (!overlap) {
      return NextResponse.json({
        success: false,
        error: 'You can only edit staff assigned to a location where you are an owner.',
      }, { status: 403 })
    }
    // Validate every assignment in the request body is at one of the
    // caller's owner-locations (and uses an OWNER_ASSIGNABLE_ROLES role).
    if (body.assignments) {
      for (const a of body.assignments) {
        if (!callerOwnerLocations.has(a.location_id)) {
          return NextResponse.json({
            success: false,
            error: 'You can only manage assignments at locations where you are an owner.',
          }, { status: 403 })
        }
        if (!OWNER_ASSIGNABLE_ROLES.includes(a.role)) {
          return NextResponse.json({
            success: false,
            error: `Role '${a.role}' cannot be granted by an owner.`,
          }, { status: 403 })
        }
      }
    }
  } else if (body.assignments) {
    // Master path: still validate role values.
    for (const a of body.assignments) {
      if (!MASTER_ASSIGNABLE_ROLES.includes(a.role)) {
        return NextResponse.json({
          success: false,
          error: `Role '${a.role}' is not a valid per-location role.`,
        }, { status: 403 })
      }
    }
  }

  // Apply profile-level updates (full_name, HR fields, master flag,
  // permissions, active). profiles.role is recomputed AFTER assignment
  // updates so it reflects the final state.
  const profileUpdates = {}
  if (body.full_name !== undefined) profileUpdates.full_name = body.full_name
  if (body.permissions !== undefined) profileUpdates.permissions = body.permissions
  if (body.active !== undefined) profileUpdates.active = body.active
  if (body.employment_type !== undefined) profileUpdates.employment_type = body.employment_type
  if (body.annual_salary !== undefined) profileUpdates.annual_salary = body.annual_salary
  if (body.hourly_rate !== undefined) profileUpdates.hourly_rate = body.hourly_rate
  if (body.contracted_hours_per_week !== undefined) profileUpdates.contracted_hours_per_week = body.contracted_hours_per_week
  if (body.annual_leave_entitlement !== undefined) profileUpdates.annual_leave_entitlement = body.annual_leave_entitlement
  if (body.overtime_rate !== undefined) profileUpdates.overtime_rate = body.overtime_rate

  if (Object.keys(profileUpdates).length > 0) {
    const { error } = await db.from('profiles').update(profileUpdates).eq('id', id)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // ----- Assignment diff -----
  //
  // The body's `assignments` array is the DESIRED-STATE for the
  // caller's reachable subset:
  //   - master: full desired-state (every location for the user)
  //   - owner: desired-state at THE OWNER'S OWN owner-locations only.
  //     Assignments at other locations are preserved from the
  //     existing row — owner can't see them, can't change them.
  //
  // Steps:
  //   1. Compute the FULL desired list (caller's subset + preserved rest)
  //   2. Diff against existing rows
  //   3. Apply: delete-with-revoke / insert / update + UniFi sync
  let unifiErrors = []
  if (body.assignments !== undefined) {
    const callerScope = user.isMaster
      ? null
      : new Set(
          Object.entries(user.rolesByLocation || {})
            .filter(([, r]) => r === 'owner')
            .map(([loc]) => loc)
        )

    const existingByLocation = Object.fromEntries(
      (targetBefore.profile_locations || []).map(l => [l.location_id, l])
    )

    // Build the FULL desired list. Master replaces every row with the
    // body. Owner replaces only their owned-locations subset and
    // preserves rows at locations they don't own.
    const desired = []
    if (user.isMaster) {
      for (const a of body.assignments) desired.push(a)
    } else {
      for (const a of body.assignments) {
        if (callerScope.has(a.location_id)) desired.push(a)
      }
      for (const link of (targetBefore.profile_locations || [])) {
        if (!callerScope.has(link.location_id)) {
          // Preserve every field of locations the caller can't touch
          // — role, is_default, door access, AND the existing
          // permissions blob (mig 058). Without this preservation,
          // an owner editing one location of a multi-location user
          // would silently zero out per-location overrides set by
          // someone else at other locations.
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

    // Promote one is_default if none set.
    if (desired.length > 0 && !desired.some(a => a.is_default)) {
      desired[0].is_default = true
    }
    // Ensure exactly one is_default.
    let seenDefault = false
    for (const a of desired) {
      if (a.is_default) {
        if (seenDefault) a.is_default = false
        else seenDefault = true
      }
    }

    const desiredIds = new Set(desired.map(a => a.location_id))

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
      const locationRow = existing?.locations
      if (locationRow) {
        try {
          unifiUserId = await applyDoorAccessChange({
            profile: targetBefore,
            location: locationRow,
            enable: wantsDoor,
            role: a.role,
            existingUnifiUserId: unifiUserId,
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
      }

      const row = {
        profile_id: id,
        location_id: a.location_id,
        role: a.role,
        is_default: !!a.is_default,
        unifi_door_access: wantsDoor,
        unifi_synced_at: new Date().toISOString(),
        unifi_user_id: unifiUserId,
        // Per-location user overrides (mig 058). Default to {} when
        // not provided so existing role-default behaviour kicks in.
        permissions: a.permissions || {},
      }

      if (existing) {
        await db.from('profile_locations')
          .update(row)
          .eq('profile_id', id)
          .eq('location_id', a.location_id)
      } else {
        await db.from('profile_locations').insert(row)
      }
    }
  }

  // ----- Recompute profiles.role + master flag -----
  //
  // profiles.role: 'master' if is_master is set OR the existing flag
  // says so AND nothing changed it; otherwise the highest role across
  // current assignments.
  const { data: refreshed } = await db
    .from('profiles')
    .select('*, profile_locations(*, locations(*))')
    .eq('id', id)
    .single()

  const currentMaster = body.is_master !== undefined ? body.is_master : refreshed.role === 'master'
  const ROLE_PRECEDENCE = { owner: 1, manager: 2, head_coach: 3, staff: 4 }
  const highest = (refreshed.profile_locations || [])
    .map(l => l.role)
    .sort((a, b) => (ROLE_PRECEDENCE[a] || 99) - (ROLE_PRECEDENCE[b] || 99))[0]
  const newProfileRole = currentMaster ? 'master' : (highest || refreshed.role || 'staff')
  if (newProfileRole !== refreshed.role) {
    await db.from('profiles').update({ role: newProfileRole }).eq('id', id)
  }

  // Keep legacy profiles.unifi_door_access flag in sync so older
  // readers don't get stale data.
  const anyDoorOn = (refreshed.profile_locations || []).some(l => l.unifi_door_access === true)
  if (anyDoorOn !== refreshed.unifi_door_access) {
    await db.from('profiles').update({ unifi_door_access: anyDoorOn }).eq('id', id)
  }

  // If any UniFi sync failed, surface it. The DB writes that succeeded
  // before the failure are kept (they're independent per-location).
  if (unifiErrors.length) {
    return NextResponse.json({
      success: false,
      error: unifiErrors.join(' '),
      unifi_failed: true,
    }, { status: 502 })
  }

  // Final re-fetch for the response.
  const { data: final } = await db
    .from('profiles')
    .select('*, profile_locations(*, locations(*))')
    .eq('id', id)
    .single()

  return NextResponse.json({ success: true, data: final })
}

// DELETE /api/staff/[id] — Soft-delete (deactivate) a staff member.
// master + owner-at-any-of-their-locations.
//
// Revokes any UniFi door-access policies the staff member had — we
// don't want a deactivated employee still able to walk into the studio.
export async function DELETE(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!user.isMaster && user.role !== 'owner') {
    return NextResponse.json({
      success: false,
      error: 'Forbidden — must be an owner at this location (or a master) to deactivate staff',
    }, { status: 403 })
  }

  const { id } = params

  // Don't let a user deactivate themselves — that would lock them out and
  // potentially leave the org with no active owner.
  if (id === user.id) {
    return NextResponse.json({
      success: false,
      error: 'Cannot deactivate your own account',
    }, { status: 400 })
  }

  const db = createServerClient()

  const { data: profile } = await db
    .from('profiles')
    .select('id, profile_locations(*, locations(*))')
    .eq('id', id)
    .single()

  // Owners must overlap with the target on at least one location.
  if (!user.isMaster) {
    const callerOwnerLocations = new Set(
      Object.entries(user.rolesByLocation || {})
        .filter(([, r]) => r === 'owner')
        .map(([loc]) => loc)
    )
    const targetLocations = (profile?.profile_locations || []).map(l => l.location_id)
    const overlap = targetLocations.some(l => callerOwnerLocations.has(l))
    if (!overlap) {
      return NextResponse.json({
        success: false,
        error: 'You can only deactivate staff assigned to a location where you are an owner.',
      }, { status: 403 })
    }
  }

  // Revoke door access first. If UniFi is unreachable on any
  // location, surface the error so an owner can retry — better than
  // silently leaving an ex-employee with active doors. The HTTP 502
  // makes it clear the deactivation did not happen.
  for (const link of profile?.profile_locations || []) {
    if (!link.unifi_door_access || !link.unifi_user_id || !link.locations) continue
    const cfg = getLocationUnifiConfig(link.locations)
    if (!cfg.configured) continue
    try {
      await revokeUnifiUserPolicies(cfg, link.unifi_user_id)
    } catch (e) {
      const msg = e instanceof UnifiError ? e.message : `UniFi revoke failed: ${e.message || e}`
      return NextResponse.json({
        success: false,
        error: `Could not revoke UniFi door access at ${link.locations.name} — ${msg}. Profile not deactivated.`,
      }, { status: 502 })
    }
  }

  // Mark inactive AND clear all per-location door flags so anyone
  // querying profile_locations.unifi_door_access immediately sees
  // the deactivation. The legacy profiles.unifi_door_access flag
  // is also flipped off for the same reason.
  const { error } = await db
    .from('profiles')
    .update({ active: false, unifi_door_access: false })
    .eq('id', id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  await db
    .from('profile_locations')
    .update({ unifi_door_access: false })
    .eq('profile_id', id)

  return NextResponse.json({ success: true })
}
