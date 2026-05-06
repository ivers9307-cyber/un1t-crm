// GET /api/studio-management/ac/state
//
// Snapshot of the active location's AC: current pod state from
// Sensibo + the most recent active session row (if any). Powers
// the live status card on the studio management page.
//
// Auth: studio_management permission.
// 412 if Sensibo not configured for the location.
// 502 if Sensibo is unreachable — UI surfaces "couldn't reach
// Sensibo, try again".

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { getPodState, SensiboError } from '@/lib/sensibo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'studio_management')) {
    return NextResponse.json(
      { success: false, error: 'Studio management is not enabled for your role at this location.' },
      { status: 403 }
    )
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location.' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: loc } = await db
    .from('locations')
    .select('id, name, sensibo_api_key, sensibo_pod_id, ac_default_mode, ac_default_temp, ac_default_fan, ac_session_minutes')
    .eq('id', locationId)
    .single()
  if (!loc) {
    return NextResponse.json({ success: false, error: 'Location not found.' }, { status: 404 })
  }

  const configured = !!(loc.sensibo_api_key && loc.sensibo_pod_id)
  if (!configured) {
    return NextResponse.json({
      success: false,
      error: 'AC is not configured for this location. A master needs to add the Sensibo API key + pod ID under Settings → Locations.',
      code: 'sensibo_not_configured',
    }, { status: 412 })
  }

  // Active session, if any.
  const { data: activeRows } = await db
    .from('ac_sessions')
    .select('id, started_by, started_at, auto_off_at, status, sensibo_pod_id, sensibo_state_snapshot, profiles:started_by(full_name)')
    .eq('location_id', locationId)
    .in('status', ['on', 'extended'])
    .order('started_at', { ascending: false })
    .limit(1)
  const session = activeRows?.[0] || null

  // Live pod state from Sensibo. Best-effort — if we can't reach
  // Sensibo we still return what we know from our own DB so the
  // UI can render the timer.
  let podState = null
  let podError = null
  try {
    podState = await getPodState(loc.sensibo_api_key, loc.sensibo_pod_id)
  } catch (e) {
    podError = e instanceof SensiboError ? e.message : `Sensibo: ${e?.message || String(e)}`
  }

  return NextResponse.json({
    success: true,
    data: {
      configured: true,
      location: { id: loc.id, name: loc.name },
      defaults: {
        mode: loc.ac_default_mode,
        temp: loc.ac_default_temp,
        fan: loc.ac_default_fan,
        session_minutes: loc.ac_session_minutes,
      },
      pod_id: loc.sensibo_pod_id,
      pod_state: podState,
      pod_state_error: podError,
      active_session: session,
    },
  })
}
