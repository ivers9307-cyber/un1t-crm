// POST /api/studio-management/ac/extend
//
// LEGACY ROUTE — kept alive for the mobile staff app which hasn't
// migrated to the device-scoped /devices/[id]/extend shape yet.
// Dispatches through src/lib/ac-devices.js using the location's
// first enabled device. The legacy route ignored the body's
// `minutes` and used a 30 min default; the dispatcher uses the
// device's per-device session_minutes (preserves the existing
// 90 min behaviour for the migrated Sensibo unit, gives the new
// bathroom devices their per-device value).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { extendSession, findDefaultDeviceForLocation } from '@/lib/ac-devices'

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
    const out = await extendSession(device.id, { user, db, request })
    if (!out.ok) {
      return NextResponse.json(
        { success: false, error: out.error, code: out.code },
        { status: out.status || 500 }
      )
    }
    return NextResponse.json({ success: true, data: out.session })
  }
)
