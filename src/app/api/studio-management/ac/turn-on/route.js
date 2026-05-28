// POST /api/studio-management/ac/turn-on
//
// LEGACY ROUTE — kept alive for the mobile staff app which hasn't
// migrated to the device-scoped /devices/[id]/turn-on shape yet.
// Resolves the active location's first enabled ac_devices row and
// dispatches through src/lib/ac-devices.js so the resulting
// ac_sessions row has a populated device_id (essential for the
// auto-off cron to pick it up).
//
// Behaviour when a session is already active: 409 with the
// existing session, same as the new device-scoped route.
//
// Phase 3 of STUDIO-AC-DEVICES — pending mobile migration which
// will retire this route entirely.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { turnOn, findDefaultDeviceForLocation } from '@/lib/ac-devices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, locationId, request }) => {
    const device = await findDefaultDeviceForLocation(locationId, db)
    if (!device) {
      return NextResponse.json({
        success: false,
        error: 'AC is not configured for this location.',
        code: 'sensibo_not_configured',
      }, { status: 412 })
    }
    const out = await turnOn(device.id, { user, db, request })
    if (!out.ok) {
      return NextResponse.json(
        { success: false, error: out.error, code: out.code, data: out.session || null },
        { status: out.status || 500 }
      )
    }
    return NextResponse.json({ success: true, data: out.session })
  }
)
