import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import {
  roleSchema, employmentTypeSchema, money, hours, days, permissionsSchema,
} from '@/lib/schemas'
import {
  getLocationUnifiConfig, findOrCreateUnifiUser,
  syncUnifiUserPolicyForRole, revokeUnifiUserPolicies, UnifiError,
} from '@/lib/unifi-access'

export const runtime = 'nodejs'

const UpdateStaffSchema = z.object({
  full_name: z.string().min(1).max(200).optional(),
  role: roleSchema.optional(),
  permissions: permissionsSchema.optional(),
  active: z.boolean().optional(),
  location_ids: z.array(uuidLike).optional(),
  employment_type: employmentTypeSchema.optional(),
  annual_salary: money.nullable().optional(),
  hourly_rate: money.nullable().optional(),
  contracted_hours_per_week: hours.nullable().optional(),
  annual_leave_entitlement: days.nullable().optional(),
  overtime_rate: money.nullable().optional(),
  // UniFi door-access toggle. Server-side this triggers a sync against
  // the staff member's default location: find-or-create the UniFi user,
  // then assign the role-appropriate access policy. Toggling off
  // revokes all policies but keeps unifi_user_id around for fast re-enable.
  unifi_door_access: z.boolean().optional(),
})

// Pick the location whose UniFi config drives door access for this profile.
// Strategy: prefer the profile's default location (is_default=true on
// profile_locations), fall back to the first one. Profiles assigned to
// multiple studios still only get access to the studio whose toggle was
// flipped — managers move someone between studios manually.
function pickDoorLocation(profile) {
  const links = profile.profile_locations || []
  const def = links.find(l => l.is_default) || links[0]
  return def?.locations || null
}

// Apply the unifi_door_access toggle. Returns the unifi_user_id that
// should be persisted (or null if it shouldn't change). Throws UnifiError
// on failure — caller is expected to surface that to the API consumer
// without persisting the toggle change in Supabase, so the UI state stays
// consistent with reality.
async function applyDoorAccessChange({ profile, location, enable, role }) {
  const cfg = getLocationUnifiConfig(location)
  if (!cfg.configured) {
    throw new UnifiError(
      'UniFi Access is not configured for this location. Add the host, ' +
      'API token and policy IDs in Location settings before enabling ' +
      'door access for staff.'
    )
  }

  if (!enable) {
    // Toggle off — only call UniFi if we have a user id to revoke against.
    // Skipping the call when unifi_user_id is null avoids an unnecessary
    // round-trip when door access was never enabled in the first place.
    if (profile.unifi_user_id) {
      await revokeUnifiUserPolicies(cfg, profile.unifi_user_id)
    }
    return profile.unifi_user_id || null
  }

  // Toggle on — find-or-create the UniFi user, then assign their role's policy.
  const unifiUserId = profile.unifi_user_id
    || await findOrCreateUnifiUser(cfg, profile)
  await syncUnifiUserPolicyForRole(cfg, unifiUserId, role)
  return unifiUserId
}

// PUT /api/staff/[id] — Update a staff member. Owner-only.
// Includes role / salary / employment fields so this endpoint must never
// be reachable without owner authentication. Manager-level edits (e.g.
// shift availability) live elsewhere.
export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Forbidden — owner only' }, { status: 403 })
  }

  const { id } = params
  const validation = await validateBody(request, UpdateStaffSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Restrict location assignments to the caller's own locations
  if (body.location_ids !== undefined) {
    const callerLocationIds = getUserLocationIds(user)
    const invalid = body.location_ids.filter(loc => !callerLocationIds.includes(loc))
    if (invalid.length > 0) {
      return NextResponse.json({
        success: false,
        error: 'Cannot assign staff to a location you do not belong to',
      }, { status: 403 })
    }
  }

  // Update profile fields
  const profileUpdates = {}
  if (body.full_name !== undefined) profileUpdates.full_name = body.full_name
  if (body.role !== undefined) profileUpdates.role = body.role
  if (body.permissions !== undefined) profileUpdates.permissions = body.permissions
  if (body.active !== undefined) profileUpdates.active = body.active
  if (body.employment_type !== undefined) profileUpdates.employment_type = body.employment_type
  if (body.annual_salary !== undefined) profileUpdates.annual_salary = body.annual_salary
  if (body.hourly_rate !== undefined) profileUpdates.hourly_rate = body.hourly_rate
  if (body.contracted_hours_per_week !== undefined) profileUpdates.contracted_hours_per_week = body.contracted_hours_per_week
  if (body.annual_leave_entitlement !== undefined) profileUpdates.annual_leave_entitlement = body.annual_leave_entitlement

  if (Object.keys(profileUpdates).length > 0) {
    const { error } = await db.from('profiles').update(profileUpdates).eq('id', id)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Update location assignments
  if (body.location_ids !== undefined) {
    await db.from('profile_locations').delete().eq('profile_id', id)
    if (body.location_ids.length > 0) {
      const links = body.location_ids.map((loc_id, i) => ({
        profile_id: id,
        location_id: loc_id,
        is_default: i === 0,
      }))
      await db.from('profile_locations').insert(links)
    }
  }

  // Re-fetch the freshly-updated profile with its location list. We do
  // this BEFORE the UniFi sync so the role / location_ids changes from
  // this request are reflected in the policy we assign.
  const { data: updatedProfile } = await db
    .from('profiles')
    .select('*, profile_locations(*, locations(*))')
    .eq('id', id)
    .single()

  // ----- UniFi sync -----
  // Triggered by:
  //   1. Explicit toggle in this request (body.unifi_door_access set), OR
  //   2. A role change while door access is currently enabled — staff →
  //      manager flips them onto the manager_policy_id automatically.
  const toggleProvided = body.unifi_door_access !== undefined
  const desiredEnabled = toggleProvided
    ? body.unifi_door_access
    : updatedProfile.unifi_door_access
  const roleChangedWhileOn =
    body.role !== undefined &&
    updatedProfile.unifi_door_access === true &&
    !toggleProvided

  if (toggleProvided || roleChangedWhileOn) {
    const location = pickDoorLocation(updatedProfile)
    if (!location) {
      return NextResponse.json({
        success: false,
        error: 'Cannot toggle door access — staff member is not assigned to any location.',
      }, { status: 400 })
    }
    try {
      const newUnifiUserId = await applyDoorAccessChange({
        profile: updatedProfile,
        location,
        enable: desiredEnabled,
        role: updatedProfile.role,
      })
      const unifiUpdates = { unifi_door_access: desiredEnabled }
      // Persist the user id only if we actually got one (find-or-create
      // path) — don't blank it on toggle-off, we want to remember.
      if (newUnifiUserId && newUnifiUserId !== updatedProfile.unifi_user_id) {
        unifiUpdates.unifi_user_id = newUnifiUserId
      }
      await db.from('profiles').update(unifiUpdates).eq('id', id)
    } catch (e) {
      const msg = e instanceof UnifiError ? e.message : `UniFi sync failed: ${e.message || e}`
      return NextResponse.json({
        success: false,
        error: msg,
        // Hint to the UI that the rest of the save succeeded but UniFi failed
        // — the toggle should bounce back to its previous state.
        unifi_failed: true,
      }, { status: 502 })
    }
  }

  // Final re-fetch so the response reflects unifi_door_access + unifi_user_id
  // changes as well.
  const { data } = await db
    .from('profiles')
    .select('*, profile_locations(*, locations(*))')
    .eq('id', id)
    .single()

  return NextResponse.json({ success: true, data })
}

// DELETE /api/staff/[id] — Soft-delete (deactivate) a staff member. Owner-only.
//
// Also revokes any UniFi door-access policies the staff member had — we
// don't want a deactivated employee still able to walk into the studio.
export async function DELETE(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Forbidden — owner only' }, { status: 403 })
  }

  const { id } = params

  // Don't let an owner deactivate themselves — that would lock them out and
  // potentially leave the org with no active owner.
  if (id === user.id) {
    return NextResponse.json({
      success: false,
      error: 'Cannot deactivate your own account',
    }, { status: 400 })
  }

  const db = createServerClient()

  // Pull the profile + locations BEFORE deactivating so we can revoke
  // UniFi access using the still-present links.
  const { data: profile } = await db
    .from('profiles')
    .select('id, unifi_door_access, unifi_user_id, profile_locations(*, locations(*))')
    .eq('id', id)
    .single()

  // Revoke door access first. If UniFi is unreachable, surface the error
  // so an owner can retry — better than silently leaving an ex-employee
  // with active doors. The HTTP 502 makes it clear the deactivation did
  // not happen.
  if (profile?.unifi_door_access && profile?.unifi_user_id) {
    const location = pickDoorLocation(profile)
    const cfg = location ? getLocationUnifiConfig(location) : null
    if (cfg?.configured) {
      try {
        await revokeUnifiUserPolicies(cfg, profile.unifi_user_id)
      } catch (e) {
        const msg = e instanceof UnifiError ? e.message : `UniFi revoke failed: ${e.message || e}`
        return NextResponse.json({
          success: false,
          error: `Could not revoke UniFi door access — ${msg}. Profile not deactivated.`,
        }, { status: 502 })
      }
    }
  }

  const { error } = await db
    .from('profiles')
    .update({ active: false, unifi_door_access: false })
    .eq('id', id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true })
}
