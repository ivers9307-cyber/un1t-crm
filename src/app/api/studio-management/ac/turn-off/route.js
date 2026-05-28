// POST /api/studio-management/ac/turn-off
//
// LEGACY ROUTE — kept alive for the mobile staff app which hasn't
// migrated to the device-scoped /devices/[id]/turn-off shape yet.
// Dispatches through src/lib/ac-devices.js using the location's
// first enabled device, so vendor dispatch + audit log work
// consistently across legacy + new callers.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { turnOff, findDefaultDeviceForLocation } from '@/lib/ac-devices'

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
    const out = await turnOff(device.id, { user, db, request })
    if (!out.ok) {
      return NextResponse.json(
        { success: false, error: out.error, code: out.code },
        { status: out.status || 500 }
      )
    }
    return NextResponse.json({ success: true })
  }
)
