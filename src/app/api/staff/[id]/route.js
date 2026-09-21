import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import {
  employmentTypeSchema, money, hours, days, permissionsSchema,
  assignmentSchema,
} from '@/lib/schemas'
import { canEditStaffMember } from '@/lib/staff-access'
import {
  applyStaffProfileWrite, assertOwnerAssignmentScope, computeDesiredAssignments, computeProfileRole,
  sparsifyAssignmentPermissions, syncStaffAssignments,
  revokeDoorAccessForDeactivation, clearLocationDoorFlags,
} from '@/lib/staff-write'
import { getStaffForUser } from '@/lib/staff'
import { logAuditEvent } from '@/lib/audit'
import { isTombstone } from '@/lib/staff-tombstone'
import { suspendStaffLogin, restoreStaffLogin } from '@/lib/staff-login-access'

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

  // ACTIVEUSER.1 (review S3) — nobody deactivates THEMSELVES here either.
  // DELETE always refused it; this handler did not, and `active:false` now
  // bans the login, so a master toggling their own Active off would lock
  // themselves out of the estate mid-request. (Owners were already refused
  // below by canEditStaffMember; masters were not.) Same copy as DELETE.
  if (id === user.id && body.active === false) {
    return NextResponse.json({ success: false, error: 'Cannot deactivate your own account' }, { status: 400 })
  }

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

  // STAFFDELETE.1 — a tombstone cannot be edited back to life. (The database
  // refuses active=true, or any role but 'staff', on one too: CHECK
  // profiles_tombstone_is_inactive.)
  if (!targetBefore || isTombstone(targetBefore)) {
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
      error: editRefusalCopy(user, targetBefore),
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

  // ACTIVEUSER.1 (review S4) — ONE meaning for "deactivate". On the true→false
  // TRANSITION this handler now does what DELETE always did: revoke the UniFi
  // door policies FIRST, and if UniFi refuses, return DELETE's 502 having
  // written nothing. Only the transition: re-saving an already inactive
  // profile must not re-run the revoke (its flags are already cleared).
  // `active !== false` rather than `=== true`, matching getCurrentUser(): a
  // row with no readable `active` is a live account.
  const deactivating = body.active === false && targetBefore.active !== false
  const reactivating = body.active === true && targetBefore.active === false
  const endsInactive = body.active === false || (body.active === undefined && targetBefore.active === false)
  if (deactivating) {
    const revokeFail = await revokeDoorAccessForDeactivation({ db, links: targetBefore.profile_locations })
    if (revokeFail) {
      return NextResponse.json({ success: false, error: revokeFail.error }, { status: revokeFail.status })
    }
  }

  // Apply profile-level updates (full_name, HR fields, master flag,
  // permissions, active) + the SECURITY.1 comp dual-write.
  // Delegated to applyStaffProfileWrite (C2b.2a) — pure mirror of
  // the previous inline block; profiles.role is recomputed AFTER
  // assignment updates so it reflects the final state.
  const profileWrite = await applyStaffProfileWrite({
    db, id, body, actorId: user.id,
    extraPatch: deactivating ? { unifi_door_access: false } : null,
  })

  // ACTIVEUSER.1 — `active` is the form's toggle AND the Reactivate button, so
  // this handler is both a deactivate and THE reactivate path. The login
  // follows the flag, and only once the PROFILES write has landed: a refused
  // deactivation (mig 080, the last active master) must ban nobody.
  //   active:false → ban a staff-only login. Sent on every such save, so
  //                  saving again IS the retry. A failure is a `warning`.
  //   active:true  → lift the ban. On a real false→true flip it is sent
  //                  outright; on an already-active profile it is the retry
  //                  for an unban that failed, and only writes if the login
  //                  is still banned. A failure is an ERROR (see loginFields).
  // A body without `active` (mobile's staff editor) never reaches the auth
  // admin API. A tombstone 404'd above, so its permanent ban is never touched.
  //
  // (review S5) "landed" is `profileWritten`, NOT `ok`: the compensation upsert
  // runs after the profiles write, so its failure used to return 400 from here
  // with `active` already flipped and the login never touched — a reactivated
  // person left banned with no signal. The login step now runs for any flip
  // that landed, and its outcome rides EVERY response below via loginFields().
  let loginAccess = null
  if (profileWrite.profileWritten) {
    if (deactivating) await clearLocationDoorFlags({ db, id })
    if (body.active === false) {
      loginAccess = await suspendStaffLogin(db, id)
    } else if (body.active === true) {
      loginAccess = await restoreStaffLogin(db, id, { transition: reactivating })
    }
  }
  // (review round 3) The audit row belongs to the TRANSITION, not to the happy
  // path: it used to sit at the very end, so a deactivation that landed and
  // then hit the comp 400 or the UniFi 502 below was never logged at all.
  if (profileWrite.profileWritten && (deactivating || reactivating)) {
    try {
      await logAuditEvent({
        category: 'business',
        action: reactivating ? 'profile.reactivated' : 'profile.deactivated',
        actor: { id: user.id, full_name: user.full_name, email: user.email },
        target: { id: targetBefore.id, label: targetBefore.full_name, resource: `profiles/${targetBefore.id}` },
        details: { before: targetBefore.active, after: body.active, login: loginAccess?.outcome || null },
        request,
      })
    } catch { /* audit must never break the response */ }
  }

  // A kept login (also a member's / host's) warns on the TRANSITION only. The
  // form sends `active` on every save and stays on the page to show a warning,
  // so repeating it for an already inactive profile would block navigation
  // forever. A ban that FAILED, or a login we could not check, always warns
  // (loginFields): those are still owed a retry.
  const login = loginFields(loginAccess, { transition: deactivating || reactivating })

  if (!profileWrite.ok) {
    return NextResponse.json({
      success: false,
      error: [profileWrite.error, login.error].filter(Boolean).join(' '),
      ...login.flags,
    }, { status: 400 })
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
    // ACTIVEUSER.1 (review S4) — syncStaffAssignments re-syncs the door policy
    // for every row whose toggle is on, and the form sends the toggles it
    // loaded. On the deactivating transition that would hand back, in the same
    // request, the door access revoked a moment ago.
    // (review R2-S2) Keyed on how the save ENDS, not on the transition: a stale
    // form (loaded active, door on) saved after someone else deactivated them
    // is `active:false` on an already inactive profile, and a door toggle
    // turned on for an inactive profile sends no `active` at all. Either would
    // grant a door policy to an inactive, banned person. The revoke-first step
    // above stays transition-only; this only stops a GRANT.
    if (endsInactive) {
      for (const a of desired) a.unifi_door_access = false
    }
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
      // ACTIVEUSER.1 (review S5) — a failed unban must not be hidden behind
      // the UniFi error: both are true, so both are said.
      error: [unifiErrors.join(' '), login.error].filter(Boolean).join(' '),
      unifi_failed: true,
      ...login.flags,
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
    // (profile.deactivated / profile.reactivated is logged earlier, the moment
    // the transition lands — see the login step above.)
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

  // ACTIVEUSER.1 — a failed UNBAN is not a warning. The profile IS reactivated
  // (the write is kept, like the UniFi branch above keeps its writes), but the
  // person cannot sign in and nothing else will ever say so — so it is the
  // response's error, with the retry in the copy. Pressing Reactivate or saving
  // again re-attempts it (restoreStaffLogin's no-transition path).
  if (login.error) {
    return NextResponse.json({ success: false, error: login.error, ...login.flags }, { status: 502 })
  }

  return NextResponse.json({
    success: true,
    data: final,
    ...login.flags,
    // Deactivating revoked every door policy and cleared the toggles, and
    // reactivating deliberately does not guess them back.
    // (Unless this very save turned one back on: then it would be false.)
    ...(reactivating && !(body.assignments || []).some(a => a.unifi_door_access)
      ? { notice: REACTIVATED_DOORS_NOTICE }
      : {}),
  })
}

const REACTIVATED_DOORS_NOTICE = 'Door access stays off until you turn it back on.'

// Why canEditStaffMember said no, in the operator's words. One copy of it, so
// PUT and DELETE cannot word the same refusal differently.
function editRefusalCopy(user, target) {
  if (target.id === user.id) return 'Owners cannot edit their own permissions. Ask a master to make this change.'
  // ACTIVEUSER.1 (review R2-S1)
  if (target.role === 'master') return 'Owners cannot edit a master account. Ask a master to make this change.'
  return 'Owners cannot edit other owners. Ask a master to make this change.'
}

// ACTIVEUSER.1 (review S5) — the login outcome in ONE shape, so no early return
// can forget half of it. `error` is a failed UNBAN (the person cannot sign in);
// `flags` are the additive response keys: `login_restore_failed` with it, and
// `warning` for the deactivate side (a failed ban or an unverifiable login
// always; a deliberately kept login on the transition only).
function loginFields(loginAccess, { transition }) {
  const error = loginAccess?.outcome === 'restore_failed' ? loginAccess.error : null
  // (review R2-S3) kept_unverified is a retryable FAILURE too: a retry that
  // comes back "could not check" again must not read as a clean success.
  const stillOwed = loginAccess?.outcome === 'ban_failed' || loginAccess?.outcome === 'kept_unverified'
  const warning = loginAccess?.warning && (transition || stillOwed) ? loginAccess.warning : null
  return {
    error,
    flags: {
      ...(error ? { login_restore_failed: true } : {}),
      ...(warning ? { warning } : {}),
    },
  }
}

// DELETE /api/staff/[id] — Soft-delete (deactivate) a staff member.
// master + owner-at-any-of-their-locations.
//
// Revokes any UniFi door-access policies the staff member had — we
// don't want a deactivated employee still able to walk into the studio.
//
// ACTIVEUSER.1 — and ENDS THEIR SESSIONS, which until now it only claimed to.
// It used to write active=false and stop: the Supabase auth user was untouched,
// so a signed-in deactivated person stayed fully signed in. Two locks now:
// getCurrentUser() refuses active=false (the one that cannot fail), and the
// login is banned here AFTER the write — see src/lib/staff-login-access.js for
// who is deliberately not banned and why a failed ban is only a warning.
// Calling it again on an inactive profile is the retry for that ban.
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
    .select('id, role, active, deleted_at, profile_locations(*, locations(*))')
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

  // ACTIVEUSER.1 — this handler now acts on the LOGIN, so it must know who it
  // is acting on. A tombstone's ban is permanent and owned by
  // /api/staff/[id]/permanent; an unknown id used to fall through to a
  // zero-row UPDATE and answer success. Both are "not found", as on PUT.
  // AFTER the owner-overlap check on purpose: an owner gets the same 403 for a
  // missing id, a tombstone (no profile_locations) and another studio's staff,
  // so this 404 is not an id-existence oracle. Only a master reaches it.
  if (!profile || isTombstone(profile)) {
    return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 })
  }

  // ACTIVEUSER.1 (review B1) — the SAME who-may-edit-whom rule PUT enforces.
  // Overlap alone let owner A deactivate, and now BAN, peer owner B at a studio
  // they share, while PUT refused that exact pair. Self is already a 400 above,
  // so the only refusal left to word is the peer-owner one. Masters pass.
  if (!canEditStaffMember(
    { id: user.id, role: user.role, isMaster: user.isMaster, rolesByLocation: user.rolesByLocation },
    { id: profile.id, role: profile.role, locationIds: (profile.profile_locations || []).map(l => l.location_id) },
  )) {
    return NextResponse.json({ success: false, error: editRefusalCopy(user, profile) }, { status: 403 })
  }

  // Revoke door access first. If UniFi is unreachable on any
  // location, surface the error so an owner can retry — better than
  // silently leaving an ex-employee with active doors. The HTTP 502
  // makes it clear the deactivation did not happen.
  // ACTIVEUSER.1 (review S4) — shared with PUT's true→false transition, so
  // "deactivate" means the same thing from either control.
  const revokeFail = await revokeDoorAccessForDeactivation({ db, links: profile.profile_locations })
  if (revokeFail) {
    return NextResponse.json({ success: false, error: revokeFail.error }, { status: revokeFail.status })
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

  await clearLocationDoorFlags({ db, id })

  // ACTIVEUSER.1 — only now, with the deactivation landed (the update above is
  // where mig 080 refuses the last active master). Never throws, and never
  // fails this response: the app is already closed to them by getCurrentUser().
  const loginAccess = await suspendStaffLogin(db, id)

  // AUDIT-EXPAND.1 — staff deactivation is high-stakes (revokes door access
  // and staff access to the platform). Logged as a business event so it
  // appears alongside contract issuance / policy publish in the unified log.
  // ACTIVEUSER.1 — "access to the platform" was not true when this comment was
  // written; `login` records what actually happened to the sign-in (banned /
  // ban_failed / kept_member_login / kept_host_login / kept_unverified).
  // A call on an ALREADY inactive profile is the dialog's "Try again" for the
  // ban, not a second deactivation: it gets its own action so the log never
  // shows one person deactivated twice.
  const wasAlreadyInactive = profile.active === false
  await logAuditEvent({
    category: 'business',
    action: wasAlreadyInactive ? 'profile.deactivation_login_step_retried' : 'profile.deactivated',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: {
      id,
      resource: `profiles/${id}`,
    },
    details: { via: 'staff_delete', login: loginAccess.outcome },
    request,
  })

  return NextResponse.json({
    success: true,
    data: { login: loginAccess.outcome },
    ...(loginAccess.warning ? { warning: loginAccess.warning } : {}),
  })
}
