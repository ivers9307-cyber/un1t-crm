// FLEET-CMD.3 — hand a fleet_admin a short-lived link to one capture.
//
// GET /api/admin/fleet/screenshot/[id]  ->  { ok, url }
//
// The bucket is private and stays private. Nothing renders the image from a
// stored public URL; every view mints a fresh signed link that dies in minutes.
//
// Gated on fleet_admin at the device's location, NOT on fleet_restart. A coach
// on shift can restart a frozen board — that must not also let them look at a
// picture of the room's live heart rates. The permission split here is about
// privacy, not about what can break the device.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Long enough to look at it, short enough that a copied link is not a leak.
const SIGNED_URL_SECONDS = 300

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const { data: command } = await db
    .from('fleet_commands')
    .select('id, device_name, screenshot_path, fleet_devices(location_id)')
    .eq('id', params.id)
    .maybeSingle()

  if (!command?.screenshot_path) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  }

  const locationId = command.fleet_devices?.location_id
  const allowed = user.isMaster
    || (locationId && hasPermissionForLocation(user, locationId, 'fleet_admin'))
  // 404 rather than 403 — someone without the grant should not learn that a
  // capture of this id exists.
  if (!allowed) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
  }

  const { data, error } = await db.storage
    .from('fleet-screenshots')
    .createSignedUrl(command.screenshot_path, SIGNED_URL_SECONDS)

  if (error || !data?.signedUrl) {
    // A pruned capture (>24h) lands here, which is the expected end state
    // rather than a fault.
    logWarn('fleet-cmd', 'could not sign screenshot', { id: params.id, err: error })
    return NextResponse.json({ ok: false, error: 'Not available' }, { status: 404 })
  }

  return NextResponse.json({ ok: true, url: data.signedUrl })
}
