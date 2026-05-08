// POST /api/studio-management/ac/turn-off
//
// Manual override — operator wants the AC off NOW. Calls Sensibo,
// stamps any active session row at this location as 'manual_off'.
// Idempotent: if no active session, we still try Sensibo (cleans
// up state if our DB lost track) and return success.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { turnPodOff, SensiboError } from '@/lib/sensibo'
import { AC_SESSION_STATUS, AC_SESSION_ACTIVE_STATUSES } from '@/lib/enums'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, locationId }) => {
    const { data: loc } = await db
      .from('locations')
      .select('id, sensibo_api_key, sensibo_pod_id')
      .eq('id', locationId)
      .single()
    if (!loc?.sensibo_api_key || !loc?.sensibo_pod_id) {
      return NextResponse.json({
        success: false, error: 'AC is not configured for this location.', code: 'sensibo_not_configured',
      }, { status: 412 })
    }

    try {
      await turnPodOff(loc.sensibo_api_key, loc.sensibo_pod_id)
    } catch (e) {
      const msg = e instanceof SensiboError ? e.message : (e?.message || String(e))
      return NextResponse.json({
        success: false, error: `Sensibo refused the request: ${msg}`, code: 'sensibo_error',
      }, { status: 502 })
    }

    // Close any active sessions for this pod at this location.
    const now = new Date().toISOString()
    await db
      .from('ac_sessions')
      .update({ status: AC_SESSION_STATUS.MANUAL_OFF, ended_at: now, ended_by: user.id })
      .eq('location_id', locationId)
      .in('status', AC_SESSION_ACTIVE_STATUSES)

    return NextResponse.json({ success: true })
  }
)
