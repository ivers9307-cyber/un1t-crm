// POST /api/studio-management/ac/devices/[id]/extend
//
// Bump the active session's auto_off_at by the device's
// session_minutes. 409 if no session is active for this device.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { extendSession } from '@/lib/ac-devices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, params, request }) => {
    const out = await extendSession(params?.id, { user, db, request })
    if (!out.ok) {
      return NextResponse.json(
        { success: false, error: out.error, code: out.code },
        { status: out.status || 500 }
      )
    }
    return NextResponse.json({ success: true, data: out.session })
  }
)
