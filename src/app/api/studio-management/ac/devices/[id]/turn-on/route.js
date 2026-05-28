// POST /api/studio-management/ac/devices/[id]/turn-on
//
// Apply the device's defaults, send the vendor power-on command,
// create a session row with auto_off_at = now + session_minutes.
// 409 if a session for this device is already active — the body
// contains the existing session so the panel can show the running
// state without resetting the timer.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { turnOn } from '@/lib/ac-devices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, params, request }) => {
    const out = await turnOn(params?.id, { user, db, request })
    if (!out.ok) {
      return NextResponse.json(
        { success: false, error: out.error, code: out.code, data: out.session || null },
        { status: out.status || 500 }
      )
    }
    return NextResponse.json({ success: true, data: out.session })
  }
)
