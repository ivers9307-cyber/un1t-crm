import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { listStaffForUser } from '@/lib/staff'
import { validateBody } from '@/lib/validate'
import { getAppUrl } from '@/lib/app-url'
import {
  employmentTypeSchema, money, hours, days, permissionsSchema,
  assignmentSchema,
  OWNER_ASSIGNABLE_ROLES, MASTER_ASSIGNABLE_ROLES,
} from '@/lib/schemas'
import { sparsifyAssignmentPermissions } from '@/lib/staff-write'

export const runtime = 'nodejs'

// Per-location-roles aware shape (mig 051). Each assignment carries
// its own role at its own location — same user can be owner at Hatch
// and head_coach at Stillorgan.
//
// `is_master` is the ONLY way to mark a user as platform-wide master;
// set ONLY by other masters. `assignments[].role` cannot be 'master'
// (CHECK constraint blocks it on the DB side; locationRoleSchema
// blocks it here).
// Password is no longer accepted on staff create — new users receive
// an invitation email and set their own password via /reset-password.
// Reduces blast radius of admin compromise (no admin ever sees a user's
// password) and matches the standard SaaS onboarding pattern.
const CreateStaffSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(1).max(200),
  is_master: z.boolean().optional(),
  assignments: z.array(assignmentSchema).optional(),
  permissions: permissionsSchema.optional(),
  employment_type: employmentTypeSchema.optional(),
  annual_salary: money.nullable().optional(),
  hourly_rate: money.nullable().optional(),
  contracted_hours_per_week: hours.nullable().optional(),
  annual_leave_entitlement: days.nullable().optional(),
  overtime_rate: money.nullable().optional(),
})

// GET /api/staff — List staff in the caller's locations.
//   - master/owner/manager: full profile + HR fields
//   - head_coach/staff: slim public roster (no salary, etc.)
// Read logic lives in src/lib/staff.js (shared with GET /api/staff/[id]
// and consumed on mobile via the SDK).
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const result = await listStaffForUser({ db, user })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data })
}

// POST /api/staff — Create a new staff member.
//
// Authorization (mig 051 per-location roles):
//   master       → can mint another master, can assign any role at any location
//   owner-at-X   → can assign any role (incl. 'owner') at locations where
//                  they themselves are owner. Cannot mint a master. Cannot
//                  assign at locations they're not owner at.
//   anyone else  → 403
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Caller must be owner-or-master AT THE CURRENT ACTIVE LOCATION
  // (or platform-wide master). user.role is now the active-location
  // role (mig 051).
  if (!user.isMaster && user.role !== 'owner') {
    return NextResponse.json({
      success: false,
      error: 'Forbidden — must be an owner at this location (or a master) to create staff',
    }, { status: 403 })
  }

  const validation = await validateBody(request, CreateStaffSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Master flag: only another master can grant it.
  if (body.is_master && !user.isMaster) {
    return NextResponse.json({
      success: false,
      error: 'Only a master account can create another master.',
    }, { status: 403 })
  }

  // Validate every requested assignment against the caller's permissions.
  // - Master can assign at any location, any role in MASTER_ASSIGNABLE_ROLES.
  // - Owner can only assign at locations where they themselves are owner,
  //   roles limited to OWNER_ASSIGNABLE_ROLES (which now includes 'owner'
  //   per the 051 design).
  const assignments = body.assignments || []
  const allowedRoles = user.isMaster ? MASTER_ASSIGNABLE_ROLES : OWNER_ASSIGNABLE_ROLES

  for (const a of assignments) {
    if (!allowedRoles.includes(a.role)) {
      return NextResponse.json({
        success: false,
        error: `Role '${a.role}' cannot be granted by ${user.isMaster ? 'master' : 'owner'}.`,
      }, { status: 403 })
    }
    if (!user.isMaster) {
      const callerRoleHere = user.rolesByLocation?.[a.location_id]
      if (callerRoleHere !== 'owner') {
        return NextResponse.json({
          success: false,
          error: 'You can only assign staff at locations where you are an owner.',
        }, { status: 403 })
      }
    }
  }

  const db = createServerClient()

  // Invite the user via Supabase Auth — sends an invitation email with a
  // magic link that takes the user to /reset-password to set their initial
  // password. The DB trigger auto-creates the profile row from the new auth
  // user. The admin never sees a password and the user owns their credential
  // from the moment it's set.
  //
  // The Supabase invite email template is configured in the Supabase
  // dashboard (Auth → Email Templates → Invite User). To customise the
  // copy / branding, edit it there. Future enhancement: swap to a Postmark-
  // sent invite email via `auth.admin.generateLink({ type: 'invite' })` for
  // full template control — not needed for v1.
  let appUrl
  try {
    appUrl = getAppUrl()
  } catch {
    // getAppUrl throws if NEXT_PUBLIC_APP_URL is unset. The redirect is
    // optional here — Supabase will use its dashboard-configured default
    // Site URL — so swallow rather than fail the create.
    appUrl = null
  }
  const { data: authData, error: authError } = await db.auth.admin.inviteUserByEmail(
    body.email,
    {
      // Phase 0a (Repset merge): positive marker consumed by the DB
      // trigger handle_new_user(). Today the trigger mints a staff
      // profile for any signup without a customer/host marker, so this
      // is a no-op; a follow-up migration inverts that to REQUIRE
      // invited_for='staff'. Route ships first — migration-first would
      // silently break staff invites.
      data: { full_name: body.full_name, invited_for: 'staff' },
      ...(appUrl ? { redirectTo: `${appUrl}/reset-password` } : {}),
    }
  )
  if (authError) {
    // Most common case: a user with this email already exists in auth.
    // Surface a clean message that suggests the reset-password flow
    // instead of leaking the raw Supabase error.
    if (/already (registered|exists|been registered)/i.test(authError.message || '')) {
      return NextResponse.json({
        success: false,
        error: 'A user with this email already exists. Use "Send password reset" on their profile to give them a fresh login link.',
        code: 'user_exists',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: authError.message }, { status: 400 })
  }

  const newUserId = authData.user.id

  // Profile updates. profiles.role:
  //   - 'master' if is_master flag is set (platform admin)
  //   - otherwise the HIGHEST per-location role across assignments,
  //     so legacy callers reading profiles.role get a sensible value
  //     (the new RLS helpers in mig 051 already prefer per-location
  //     data over profiles.role, so this is effectively cosmetic).
  const ROLE_PRECEDENCE = { owner: 1, manager: 2, head_coach: 3, staff: 4 }
  const highestRole = assignments
    .map(a => a.role)
    .sort((a, b) => (ROLE_PRECEDENCE[a] || 99) - (ROLE_PRECEDENCE[b] || 99))[0]
  const profileRole = body.is_master ? 'master' : (highestRole || 'staff')

  const updates = { role: profileRole }
  if (body.permissions) updates.permissions = body.permissions
  if (body.employment_type) updates.employment_type = body.employment_type
  // SECURITY.1 (mig 152) — comp fields dual-write: profiles columns
  // stay in sync for existing readers; profile_compensation gets the
  // canonical copy. Follow-up commit migrates readers + drops the
  // profiles columns.
  if (body.annual_salary != null) updates.annual_salary = body.annual_salary
  if (body.hourly_rate != null) updates.hourly_rate = body.hourly_rate
  if (body.contracted_hours_per_week != null) updates.contracted_hours_per_week = body.contracted_hours_per_week
  if (body.annual_leave_entitlement != null) updates.annual_leave_entitlement = body.annual_leave_entitlement
  if (body.overtime_rate !== undefined) updates.overtime_rate = body.overtime_rate

  // BAREWRITE.1 — this was a bare await. The auth-signup trigger has already
  // minted the profile with the DEFAULT role, so a silently-failed update does
  // not leave the staff member half-created: it leaves them created with the
  // WRONG role, permissions and comp, and the route still answered
  // `{ success: true }`. That is a quiet privilege mis-assignment, and it was
  // the only unchecked leg here — the profile_locations insert below already
  // surfaced its error, so a TOTAL failure was visible while a partial one was
  // not.
  //
  // The row must exist (we just created the auth user and its trigger minted
  // the profile), so zero rows matched is itself the bug — and PostgREST
  // reports NO error for an UPDATE that matches nothing. `.select('id')` is how
  // that count is obtained: it returns the rows the UPDATE actually touched.
  //
  // `{ count: 'exact' }` on a bodyless PATCH would also work — postgrest-js
  // reads `count` off Content-Range, and PostgREST does emit it for a mutation
  // (prod evidence: prune-hr-detections' heartbeat last_outcome carries
  // non-zero `detections_deleted`, which comes only from a `.delete({ count:
  // 'exact' })`). `.select()` is used anyway because it is verifiable by
  // construction rather than by a response header, and one returned id is
  // cheaper than the reasoning.
  const { error: profileError, data: profileRows } = await db
    .from('profiles')
    .update(updates)
    .eq('id', newUserId)
    .select('id')
  if (profileError || !profileRows?.length) {
    return NextResponse.json({
      success: false,
      error: `Staff login was created but the role/permissions could not be saved — the account would have defaulted to the wrong access level, so nothing else was applied. Delete the user and retry: ${profileError?.message || 'profile row not found'}`,
    }, { status: 500 })
  }

  // SECURITY.1 — second leg of the dual-write.
  const compFields = {}
  if (body.annual_salary != null)             compFields.annual_salary             = body.annual_salary
  if (body.hourly_rate != null)               compFields.hourly_rate               = body.hourly_rate
  if (body.contracted_hours_per_week != null) compFields.contracted_hours_per_week = body.contracted_hours_per_week
  if (body.annual_leave_entitlement != null)  compFields.annual_leave_entitlement  = body.annual_leave_entitlement
  if (body.overtime_rate !== undefined)       compFields.overtime_rate             = body.overtime_rate
  if (Object.keys(compFields).length > 0) {
    const { upsertCompensationForProfile } = await import('@/lib/profile-compensation')
    await upsertCompensationForProfile(db, newUserId, compFields, { actorId: user.id })
  }

  // Insert assignments. The trigger that auto-created the profile may
  // also have inserted a default profile_locations row — clear first
  // so we have full control over what lands.
  // BAREWRITE.1 — if this clear fails silently, the trigger's DEFAULT
  // profile_locations row survives and the insert below ADDS to it: the staff
  // member ends up with an access grant nobody asked for, on top of the ones
  // that were requested. No row-count check — the trigger row is not
  // guaranteed to exist, so zero rows deleted is a legitimate outcome.
  const { error: clearError } = await db.from('profile_locations').delete().eq('profile_id', newUserId)
  if (clearError) {
    return NextResponse.json({
      success: false,
      error: `Staff login was created but the default location access could not be cleared, so the requested assignments were not applied (they would have been added on top of it). Delete the user and retry: ${clearError.message}`,
    }, { status: 500 })
  }

  if (assignments.length > 0) {
    // PERM-AUDIT.3 — store only the sparse diff vs each assignment's
    // role base (code defaults + role template, mig 364).
    const sparseAssignments = await sparsifyAssignmentPermissions({
      db, assignments, employmentType: body.employment_type || null,
    })
    const hasExplicitDefault = sparseAssignments.some(a => a.is_default)
    const links = sparseAssignments.map((a, i) => ({
      profile_id: newUserId,
      location_id: a.location_id,
      role: a.role,
      is_default: hasExplicitDefault ? !!a.is_default : i === 0,
      // unifi_door_access is the toggle stamp; the actual UniFi sync
      // happens on edit (PUT) so we have a saved profile to work with.
      // On create we just persist the requested state and let the next
      // PUT do the door provisioning.
      unifi_door_access: !!a.unifi_door_access,
      // Per-location user overrides (mig 058). SPARSE — only keys
      // changed away from the role base; empty {} → pure inheritance.
      permissions: a.permissions || {},
    }))
    const { error: insertError } = await db.from('profile_locations').insert(links)
    if (insertError) {
      return NextResponse.json({ success: false, error: insertError.message }, { status: 400 })
    }
  }

  // Fetch the complete profile
  const { data: profile } = await db
    .from('profiles')
    .select('*, profile_locations(*, locations(*))')
    .eq('id', newUserId)
    .single()

  return NextResponse.json({ success: true, data: profile }, { status: 201 })
}
