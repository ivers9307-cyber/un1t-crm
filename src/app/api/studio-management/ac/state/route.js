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
import { overlayConnections } from '@/lib/connection-registry'
import { canCloseStaleSession } from '@/lib/ac-state-cache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  { permission: 'studio_management' },
  async ({ db, locationId, request }) => {
  const { data: locRow } = await db
    .from('locations')
    .select('id, name, sensibo_api_key, sensibo_pod_id, ac_default_mode, ac_default_temp, ac_default_fan, ac_session_minutes')
    .eq('id', locationId)
    .single()
  if (!locRow) {
    return NextResponse.json({ success: false, error: 'Location not found.' }, { status: 404 })
  }
  // INTEG-A2 dual-read: registry `sensibo` row replaces the legacy
  // columns when present; no row → legacy unchanged.
  const loc = await overlayConnections(db, locRow, ['sensibo'])

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

  // SENSIBO-RATE.1 — served from the ac_devices.last_state cache
  // (mig 580) rather than a live vendor call on every request, the
  // same treatment /ac/devices/[id] got. This route has no live
  // caller today (mobile's getAcState wrapper is unused) and is kept
  // only for old mobile bundles, but an old bundle polling it is
  // still real vendor load against a limiter that punishes bursts.
  //
  // `?live=1` forces a real read, through the shared limiter.
  const wantsLive = new URL(request.url).searchParams.get('live') === '1'
  const { data: sensiboDevice } = await db
    .from('ac_devices')
    .select('id, last_state, last_state_at')
    .eq('location_id', locationId)
    .eq('provider', 'sensibo')
    .eq('provider_device_id', loc.sensibo_pod_id)
    .maybeSingle()

  let podState = null
  let podError = null
  let podStateAsOf = null
  if (wantsLive) {
    try {
      podState = await getPodState(loc.sensibo_api_key, loc.sensibo_pod_id)
      podStateAsOf = new Date().toISOString()
    } catch (e) {
      podError = e instanceof SensiboError ? e.message : `Sensibo: ${e?.message || String(e)}`
    }
  } else {
    podState = sensiboDevice?.last_state ?? null
    podStateAsOf = sensiboDevice?.last_state_at ?? null
  }

  // A cached reading is fine for DISPLAY but must not drive the
  // destructive stale-session cleanup below. See ac-state-cache.js.
  const podStateIsFresh = canCloseStaleSession({ wantsLive, observedAt: podStateAsOf })

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
  if (session && podState && !podOn && podStateIsFresh) {
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
      // When pod_state was observed. null = never observed yet (the
      // next ac-external-rule tick fills it in). Additive — old
      // mobile bundles simply ignore the extra key.
      pod_state_as_of: podStateAsOf,
      pod_state_error: podError,
      active_session: session,
      is_on: isOn,
      control_source: controlSource,
    },
  })
})
