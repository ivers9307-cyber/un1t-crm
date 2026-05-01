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
  // UniFi door-access — per-location now. Map of location_id → bool.
  // Server-side, each entry triggers an independent UniFi sync against
  // that location's UniFi instance. Locations not present in the map
  // are left as-is (no toggle = no change).
  unifi_door_access_per_location: z.record(uuidLike, z.boolean()).optional(),
  // Legacy single-toggle field. Still accepted from older clients —
  // applied to the staff member's default location for backwards-compat.
  unifi_door_access: z.boolean().optional(),
})

// Pick the staff member's default location from their profile_locations
// list. Used only for backwards-compat with the legacy single-toggle
// `unifi_door_access` field — newer clients send the per-location map.
function pickDefaultLocation(profile) {
  const links = profile.profile_locations || []
  const def = links.find(l => l.is_default) || links[0]
  return def?.locations || null
}

// Apply a per-location door-access toggle. Returns the unifi_user_id
// that should be persisted on the profile_locations row (or null if
// nothing should change).
//
// `existingUnifiUserId` is the per-location UniFi user id we already
// have stored for this (profile, location) pair, if any.
//
// Throws UnifiError on failure — the caller surfaces the message to
// the API consumer without persisting the toggle change in
// profile_locations, so the UI state stays consistent with reality.
//
// Toggle-off semantics: best-effort. If UniFi is configured AND we
// have a user id to revoke, do it. Otherwise just persist the toggle
// — there's nothing to revoke and the user's intent should be
// honoured. (This was the bug that blocked the whole staff form from
// saving when a location had no UniFi config.)
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

// PUT /api/staff/[id] — Update a staff member. Owner-only.
// Includes role / salary / employment fields so this endpoint must never
// be reachable without owner-or-master authentication. Manager-level
// edits (e.g. shift availability) live elsewhere.
//
// Role-grant rule (mig 033): owners can never set role to 'owner' or
// 'master' — that requires a master account. Enforced below alongside
// the basic auth check.
export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Forbidden — owner or master only' }, { status: 403 })
  }

  const { id } = params
  const validation = await validateBody(request, UpdateStaffSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Role-grant guard: only a master can grant 'owner' or 'master'.
  if (body.role && (body.role === 'owner' || body.role === 'master') && user.role !== 'master') {
    return NextResponse.json({
      success: false,
      error: `Only a master account can promote a user to '${body.role}'.`,
    }, { status: 403 })
  }

  // Restrict location assignments to the caller's own locations.
  // Master skips this — getUserLocationIds returns every location for
  // them, but we short-circuit explicitly so future role-shape
  // changes don't accidentally narrow master's reach.
  if (body.location_ids !== undefined && user.role !== 'master') {
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

  // ----- UniFi sync (per-location) -----
  //
  // Build a desired-state map keyed by location_id from:
  //   1. Explicit per-location map in this request
  //      (body.unifi_door_access_per_location), OR
  //   2. Legacy single-toggle (body.unifi_door_access) applied to the
  //      profile's default location only (back-compat for older clients), OR
  //   3. Role change while ANY location row has door access on — re-sync
  //      that location's policy so a promotion/demotion auto-flips to the
  //      right access level.
  //
  // Locations not present in the desired-state map are left as-is.
  const desiredByLocation = {}
  let toggleProvided = false

  if (body.unifi_door_access_per_location) {
    toggleProvided = true
    for (const [locId, enabled] of Object.entries(body.unifi_door_access_per_location)) {
      desiredByLocation[locId] = !!enabled
    }
  }

  if (body.unifi_door_access !== undefined && !body.unifi_door_access_per_location) {
    // Legacy path — apply to the default location only.
    toggleProvided = true
    const def = pickDefaultLocation(updatedProfile)
    if (def && desiredByLocation[def.id] === undefined) {
      desiredByLocation[def.id] = !!body.unifi_door_access
    }
  }

  if (body.role !== undefined && !toggleProvided) {
    // Role change re-sync — only for currently-enabled rows.
    for (const link of updatedProfile.profile_locations || []) {
      if (link.unifi_door_access === true && link.locations) {
        desiredByLocation[link.location_id] = true
      }
    }
  }

  // Walk each (location_id, desired) entry, calling that location's
  // UniFi instance independently. Failures on one location don't roll
  // back successful syncs on other locations — staff form save is
  // best-effort overall, and surfaces the first failure to the user.
  if (Object.keys(desiredByLocation).length) {
    const linksByLocation = Object.fromEntries(
      (updatedProfile.profile_locations || []).map(l => [l.location_id, l])
    )
    const errors = []
    for (const [locId, desired] of Object.entries(desiredByLocation)) {
      const link = linksByLocation[locId]
      if (!link || !link.locations) continue // staff isn't even assigned here, skip silently
      try {
        const newUnifiUserId = await applyDoorAccessChange({
          profile: updatedProfile,
          location: link.locations,
          enable: desired,
          role: updatedProfile.role,
          existingUnifiUserId: link.unifi_user_id,
        })
        const updates = {
          unifi_door_access: desired,
          unifi_synced_at: new Date().toISOString(),
        }
        if (newUnifiUserId && newUnifiUserId !== link.unifi_user_id) {
          updates.unifi_user_id = newUnifiUserId
        }
        await db.from('profile_locations')
          .update(updates)
          .eq('profile_id', id)
          .eq('location_id', locId)
      } catch (e) {
        errors.push(e instanceof UnifiError ? e.message : `UniFi sync failed at ${link.locations.name}: ${e.message || e}`)
      }
    }
    if (errors.length) {
      return NextResponse.json({
        success: false,
        error: errors.join(' '),
        unifi_failed: true,
      }, { status: 502 })
    }

    // Keep the legacy profiles.unifi_door_access flag in sync as
    // "any location enabled" so older readers don't get stale data.
    const { data: refreshedLinks } = await db
      .from('profile_locations')
      .select('unifi_door_access')
      .eq('profile_id', id)
    const anyOn = (refreshedLinks || []).some(l => l.unifi_door_access === true)
    await db.from('profiles')
      .update({ unifi_door_access: anyOn })
      .eq('id', id)
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

// DELETE /api/staff/[id] — Soft-delete (deactivate) a staff member.
// Owner-or-master only.
//
// Also revokes any UniFi door-access policies the staff member had — we
// don't want a deactivated employee still able to walk into the studio.
export async function DELETE(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Forbidden — owner or master only' }, { status: 403 })
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

  // Pull the profile + per-location door state BEFORE deactivating
  // so we can walk every location-level UniFi instance and revoke
  // independently. Migration 024 split the single profile-level
  // unifi_door_access flag into per-row columns on profile_locations,
  // so an ex-employee assigned to two studios needs both revoked.
  const { data: profile } = await db
    .from('profiles')
    .select('id, profile_locations(*, locations(*))')
    .eq('id', id)
    .single()

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
