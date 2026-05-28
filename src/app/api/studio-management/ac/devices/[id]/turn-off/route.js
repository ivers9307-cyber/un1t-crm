// POST /api/studio-management/ac/devices/[id]/turn-off
//
// Send the vendor power-off command and mark any active sessions
// for this device as manual_off. Safe to call when no session is
// active — the vendor still receives the power-off command in case
// the AC was started outside the app.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { turnOff } from '@/lib/ac-devices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, params, request }) => {
    const out = await turnOff(params?.id, { user, db, request })
    if (!out.ok) {
      return NextResponse.json(
        { success: false, error: out.error, code: out.code },
        { status: out.status || 500 }
      )
    }
    return NextResponse.json({
      success: true,
      data: { sessions_closed: out.sessions_closed },
    })
  }
)
