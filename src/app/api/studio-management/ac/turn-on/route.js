// POST /api/studio-management/ac/turn-on
//
// Apply the location's AC preset and start a session with
// auto_off_at = now + ac_session_minutes (default 90).
//
// Behaviour when a session is already active (option B per spec):
// no-op — return the existing session with a "still running"
// message including minutes remaining. The UI surfaces that
// directly without a destructive change.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import {
  setPodState, buildTurnOnState, SensiboError,
} from '@/lib/sensibo'
import { AC_SESSION_STATUS, AC_SESSION_ACTIVE_STATUSES } from '@/lib/enums'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
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
  if (!loc.sensibo_api_key || !loc.sensibo_pod_id) {
    return NextResponse.json({
      success: false,
      error: 'AC is not configured for this location.',
      code: 'sensibo_not_configured',
    }, { status: 412 })
  }

  // Already-running guard (option B): tell the operator how long
  // is left, don't reset the timer or fire another Sensibo call.
  const { data: openRows } = await db
    .from('ac_sessions')
    .select('id, started_at, auto_off_at, status, started_by, profiles:started_by(full_name)')
    .eq('location_id', locationId)
    .in('status', AC_SESSION_ACTIVE_STATUSES)
    .order('started_at', { ascending: false })
    .limit(1)
  const existing = openRows?.[0]
  if (existing) {
    const minsLeft = existing.auto_off_at
      ? Math.max(0, Math.round((new Date(existing.auto_off_at).getTime() - Date.now()) / 60000))
      : null
    return NextResponse.json({
      success: false,
      error:
        `AC is already on${existing.profiles?.full_name ? ` (started by ${existing.profiles.full_name})` : ''}` +
        (minsLeft != null ? ` — ${minsLeft} min remaining.` : '.'),
      code: 'already_running',
      data: existing,
    }, { status: 409 })
  }

  // Compute the desired state + auto-off time.
  const desired = buildTurnOnState({
    mode: loc.ac_default_mode,
    temp: loc.ac_default_temp,
    fan: loc.ac_default_fan,
  })
  const minutes = loc.ac_session_minutes || 90
  const autoOffAt = new Date(Date.now() + minutes * 60_000).toISOString()

  // Send to Sensibo first — only write our session if the AC
  // actually came on. If Sensibo errors, we surface it; nothing
  // got persisted so retry is clean.
  let observed
  try {
    observed = await setPodState(loc.sensibo_api_key, loc.sensibo_pod_id, desired)
  } catch (e) {
    const msg = e instanceof SensiboError ? e.message : (e?.message || String(e))
    return NextResponse.json({
      success: false,
      error: `Sensibo refused the request: ${msg}`,
      code: 'sensibo_error',
    }, { status: 502 })
  }

  const { data: session, error: insErr } = await db
    .from('ac_sessions')
    .insert({
      location_id: locationId,
      sensibo_pod_id: loc.sensibo_pod_id,
      started_by: user.id,
      auto_off_at: autoOffAt,
      status: AC_SESSION_STATUS.ON,
      sensibo_state_snapshot: observed,
    })
    .select()
    .single()

  if (insErr) {
    // Roll back the Sensibo turn-on best-effort. If this fails too,
    // the auto-off cron will still pick it up via Sensibo state at
    // some point, but worst case the AC runs the configured
    // session_minutes — bounded.
    try {
      const { turnPodOff } = await import('@/lib/sensibo')
      await turnPodOff(loc.sensibo_api_key, loc.sensibo_pod_id)
    } catch { /* best-effort */ }
    return NextResponse.json({ success: false, error: insErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: session })
}
