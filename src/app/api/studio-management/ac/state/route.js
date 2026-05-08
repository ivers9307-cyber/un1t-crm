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
import { withAuth } from '@/lib/with-auth'
import { getPodState, SensiboError } from '@/lib/sensibo'
import { AC_SESSION_STATUS, AC_SESSION_ACTIVE_STATUSES } from '@/lib/enums'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  { permission: 'studio_management' },
  async ({ db, locationId }) => {
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
    .in('status', AC_SESSION_ACTIVE_STATUSES)
    .order('started_at', { ascending: false })
    .limit(1)
  let session = activeRows?.[0] || null

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

  // Reconcile state. The pod state (Sensibo) is the ground truth
  // for whether the AC is physically on right now — staff can flip
  // it at the wall panel or it can be turned off by a Sensibo
  // schedule, neither of which goes through our app. We treat the
  // session row as context-only ("who turned it on through the
  // app, when does our auto-off cron fire") and auto-clean stale
  // sessions when Sensibo says the AC is off:
  //
  //   - is_on        : did Sensibo report the AC physically on?
  //   - control_source:
  //       'app'      → our session row says on AND pod_state agrees
  //       'external' → pod_state says on but no app session
  //                    (someone hit the wall panel or a Sensibo
  //                    schedule kicked in)
  //       null       → AC is off
  //
  // Stale-session cleanup: if we have a session row in on/extended
  // state but Sensibo says the AC is off, the staff member turned
  // it off at the wall panel or via Sensibo. Mark the row as
  // 'manual_off' here so the auto-off cron doesn't try to re-stop
  // an already-stopped pod, and so the audit trail captures that
  // it ended outside the app. Status enum values from mig 103:
  // on / auto_off / manual_off / extended / failed.
  const podOn = podState?.on === true
  if (session && podState && !podOn) {
    await db
      .from('ac_sessions')
      .update({
        status: AC_SESSION_STATUS.MANUAL_OFF,
        ended_at: new Date().toISOString(),
        failure_reason: 'turned off externally (wall panel or Sensibo schedule)',
      })
      .eq('id', session.id)
      .in('status', AC_SESSION_ACTIVE_STATUSES)
    session = null
  }
  // If pod_state failed to load, fall back to "session means on"
  // (stale-tolerant) so the UI doesn't flicker every time Sensibo
  // hiccups. control_source then reflects what we know from our
  // own DB.
  let isOn
  let controlSource
  if (podError) {
    isOn = !!session
    controlSource = session ? 'app' : null
  } else if (podOn && session) {
    isOn = true; controlSource = 'app'
  } else if (podOn && !session) {
    isOn = true; controlSource = 'external'
  } else {
    isOn = false; controlSource = null
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
      is_on: isOn,
      control_source: controlSource,
    },
  })
})
