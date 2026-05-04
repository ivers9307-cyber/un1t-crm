// GET /api/studio-management/doors
//
// Returns the list of doors known to the active location's UniFi
// Access controller. Powers the unlock-button list on
// /studio-management. Caller must have the studio_management
// permission AT their active location.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { getLocationUnifiConfig, listDoors, UnifiError } from '@/lib/unifi-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
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

  const db = createServerClient()
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
      error: 'UniFi Access is not fully configured for this location. Ask a master to fill in the controller settings under Settings → Locations.',
      code: 'unifi_not_configured',
    }, { status: 412 })
  }

  try {
    const doors = await listDoors(cfg)
    // Trim down to what the UI needs — id + display name. Some
    // firmwares return camelCase, others snake_case, so we normalise.
    const trimmed = doors.map((d) => ({
      id: d.id || d.unique_id || d.door_id,
      name: d.name || d.display_name || d.title || 'Unnamed door',
    })).filter(d => d.id)
    return NextResponse.json({ success: true, data: trimmed })
  } catch (e) {
    const status = e instanceof UnifiError && e.status ? e.status : 502
    return NextResponse.json({
      success: false,
      error: e instanceof UnifiError ? e.message : `UniFi request failed: ${e.message || e}`,
    }, { status })
  }
}
