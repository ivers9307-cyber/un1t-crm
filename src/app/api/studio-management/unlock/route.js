// POST /api/studio-management/unlock
//
// Triggers a one-shot remote unlock on a single door at the active
// location's UniFi controller. Caller must have the
// studio_management permission AT their active location.
//
// Body: { door_id: string }
//
// Logs the unlock attempt to the activities timeline so there's a
// CRM-side audit trail in addition to whatever UniFi keeps. We
// fire-and-forget the activities insert — the unlock has already
// happened, we don't want a logging failure to confuse the operator.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { getLocationUnifiConfig, remoteUnlockDoor, UnifiError } from '@/lib/unifi-access'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  door_id: z.string().min(1).max(200),
  // Optional human-readable name for the activity log — saves us a
  // round-trip to listDoors on every unlock.
  door_name: z.string().max(200).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'studio_management')) {
    return NextResponse.json({
      success: false,
      error: 'Studio management is not enabled for your role at this location.',
    }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location.' }, { status: 400 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { door_id, door_name } = validation.data

  const db = createServerClient()

  // UNIFI-DOORS-SCOPE — verify door_id is in the caller's allowlist
  // for this location. The /doors GET endpoint already filters the
  // visible list, but a hand-crafted POST (e.g. devtools or a
  // misbehaving client) could try to unlock a door it shouldn't see.
  // This is the actual security barrier.
  //
  // NULL allowlist (mig 182 left manager+ roles as NULL) = legacy
  // fallback, all doors permitted. Empty array = no doors permitted.
  const { data: assignment } = await db
    .from('profile_locations')
    .select('unifi_door_ids')
    .eq('profile_id', user.id)
    .eq('location_id', locationId)
    .maybeSingle()
  const allowlist = assignment?.unifi_door_ids
  const isUnrestricted = allowlist === null || allowlist === undefined
  if (!isUnrestricted && !allowlist.includes(door_id)) {
    return NextResponse.json({
      success: false,
      error: 'You are not authorised to unlock this door. Ask an admin to add it to your access list.',
    }, { status: 403 })
  }

  const { data: location } = await db
    .from('locations')
    .select('id, name, settings')
    .eq('id', locationId)
    .single()
  if (!location) {
    return NextResponse.json({ success: false, error: 'Location not found.' }, { status: 404 })
  }

  const cfg = getLocationUnifiConfig(location)
  if (!cfg.configured) {
    return NextResponse.json({
      success: false,
      error: 'UniFi Access is not fully configured for this location.',
      code: 'unifi_not_configured',
    }, { status: 412 })
  }

  try {
    // UniFi Access wants actor_id + actor_name (both required if
    // either is set). Use the CRM user's UUID + display name so the
    // UniFi audit log shows the human who pressed the button.
    const actorName = user.full_name || user.fullName || user.name || user.email || 'CRM user'
    await remoteUnlockDoor(cfg, door_id, { actorId: user.id, actorName })
    // Best-effort audit row. activities.kind='event' (mig 073) so
    // it lands on the timeline without showing up as a task.
    db.from('activities').insert({
      kind: 'event',
      type: 'door_unlock',
      title: `Unlocked ${door_name || 'door'} at ${location.name}`,
      profile_id: user.id,
      location_id: locationId,
    }).then(() => {}).catch((e) => {
      logWarn('studio-management', `activity log failed`, { err: e })
    })
    return NextResponse.json({ success: true })
  } catch (e) {
    const status = e instanceof UnifiError && e.status ? e.status : 502
    return NextResponse.json({
      success: false,
      error: e instanceof UnifiError ? e.message : `UniFi request failed: ${e.message || e}`,
    }, { status })
  }
}
