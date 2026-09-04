import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import {
  employmentTypeSchema, money, hours, days, permissionsSchema,
  assignmentSchema,
} from '@/lib/schemas'
import {
  getUnifiConfig, revokeUnifiUserPolicies, UnifiError,
} from '@/lib/unifi-access'
import { canEditStaffMember } from '@/lib/staff-access'
import { applyStaffProfileWrite, assertOwnerAssignmentScope, computeDesiredAssignments, computeProfileRole, sparsifyAssignmentPermissions, syncStaffAssignments } from '@/lib/staff-write'
import { getStaffForUser } from '@/lib/staff'
import { logAuditEvent } from '@/lib/audit'

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

// GET /api/staff/[id] — fetch one staff member (scoped to the caller's
// locations; admins see HR fields). New in C1: the web edit page reads
// the DB directly, so this route exists for the mobile staff directory
// + any SDK consumer. Read logic lives in src/lib/staff.js.
export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const result = await getStaffForUser({ db, user, id: params.id })
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status || 400 })
  }
  return NextResponse.json({ success: true, data: result.data })
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
export async function PUT(request, props) {
  const params = await props.params;
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
    { id: user.id, role: user.role, isMaster: user.isMaster, rolesByLocation: user.rolesByLocation },
    {
      id: targetBefore.id,
      role: targetBefore.role,
      // STAFF-EDIT-RULE.1 — the helper now asks the question its doc always
      // claimed (owner AT one of the target's locations), so it needs them.
      locationIds: (targetBefore.profile_locations || []).map(l => l.location_id),
    },
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
  {
    const callerOwnerLocationIds = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner')
      .map(([loc]) => loc)
    const targetLocationIds = (targetBefore.profile_locations || []).map(l => l.location_id)
    const scopeErr = assertOwnerAssignmentScope({
      isMaster: user.isMaster,
      callerOwnerLocationIds,
      targetLocationIds,
      assignments: body.assignments,
    })
    if (scopeErr) return NextResponse.json({ success: false, error: scopeErr.error }, { status: scopeErr.status })
  }

  // Apply profile-level updates (full_name, HR fields, master flag,
  // permissions, active) + the SECURITY.1 comp dual-write.
  // Delegated to applyStaffProfileWrite (C2b.2a) — pure mirror of
  // the previous inline block; profiles.role is recomputed AFTER
  // assignment updates so it reflects the final state.
  const profileWrite = await applyStaffProfileWrite({ db, id, body, actorId: user.id })
  if (!profileWrite.ok) {
    return NextResponse.json({ success: false, error: profileWrite.error }, { status: 400 })
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
    const callerOwnerLocationIds = user.isMaster
      ? []
      : Object.entries(user.rolesByLocation || {}).filter(([, r]) => r === 'owner').map(([loc]) => loc)
    const existingByLocation = Object.fromEntries(
      (targetBefore.profile_locations || []).map(l => [l.location_id, l])
    )
    // PERM-AUDIT.3 — store only the sparse diff vs each assignment's
    // role base (code defaults + role template, mig 364). Editors
    // send full hydrated blobs; the server owns the reduction.
    // RECEPTION.2: the base includes the target's employment-type
    // variant — use the employment type this request SETS if present,
    // else the target's stored one.
    const desired = await sparsifyAssignmentPermissions({
      db,
      employmentType: body.employment_type ?? targetBefore.employment_type ?? null,
      assignments: computeDesiredAssignments({
        isMaster: user.isMaster,
        callerOwnerLocationIds,
        assignments: body.assignments,
        existingLinks: targetBefore.profile_locations || [],
      }),
    })
    const desiredIds = new Set(desired.map(a => a.location_id))

    const syncResult = await syncStaffAssignments({
      db, id, targetBefore, desired, desiredIds, existingByLocation,
    })
    unifiErrors = syncResult.unifiErrors
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
  const newProfileRole = computeProfileRole({
    isMaster: currentMaster,
    assignmentRoles: (refreshed.profile_locations || []).map(l => l.role),
    fallbackRole: refreshed.role,
  })
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

  // AUDIT-EXPAND.1 — emit individual events for the high-stakes
  // profile-level changes that happened in this request. Skipping
  // routine HR/comp edits (those are captured by the DB-trigger
  // pass in v2). Per-assignment changes are handled by
  // logAssignmentChange in the dedicated assignment routes; the
  // bulk diff above doesn't go through there yet but assignment
  // routes are the more common surface.
  try {
    const actorRef = { id: user.id, full_name: user.full_name, email: user.email }
    const targetRef = {
      id: targetBefore.id,
      label: targetBefore.full_name,
      resource: `profiles/${targetBefore.id}`,
    }
    if (body.is_master !== undefined && body.is_master !== (targetBefore.role === 'master')) {
      await logAuditEvent({
        category: 'auth',
        action: body.is_master ? 'master.granted' : 'master.revoked',
        actor: actorRef,
        target: targetRef,
        details: { before: targetBefore.role === 'master', after: body.is_master },
        request,
      })
    }
    if (body.active !== undefined && body.active !== targetBefore.active) {
      await logAuditEvent({
        category: 'business',
        action: body.active ? 'profile.reactivated' : 'profile.deactivated',
        actor: actorRef,
        target: targetRef,
        details: { before: targetBefore.active, after: body.active },
        request,
      })
    }
    if (body.permissions !== undefined) {
      const beforeP = JSON.stringify(targetBefore.permissions || {})
      const afterP = JSON.stringify(body.permissions || {})
      if (beforeP !== afterP) {
        await logAuditEvent({
          category: 'business',
          action: 'permissions.updated',
          actor: actorRef,
          target: targetRef,
          details: { before: targetBefore.permissions || {}, after: body.permissions || {} },
          request,
        })
      }
    }
  } catch { /* audit must never break the response */ }

  return NextResponse.json({ success: true, data: final })
}

// DELETE /api/staff/[id] — Soft-delete (deactivate) a staff member.
// master + owner-at-any-of-their-locations.
//
// Revokes any UniFi door-access policies the staff member had — we
// don't want a deactivated employee still able to walk into the studio.
export async function DELETE(request, props) {
  const params = await props.params;
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
    // INTEG-A2 dual-read: registry row first, legacy settings.unifi otherwise.
    const cfg = await getUnifiConfig(db, link.locations)
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

  // AUDIT-EXPAND.1 — staff deactivation is high-stakes (revokes
  // door access + access to the platform). Logged as a business
  // event so it appears alongside contract issuance / policy
  // publish in the unified log.
  await logAuditEvent({
    category: 'business',
    action: 'profile.deactivated',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: {
      id,
      resource: `profiles/${id}`,
    },
    details: { via: 'staff_delete' },
    request,
  })

  return NextResponse.json({ success: true })
}
