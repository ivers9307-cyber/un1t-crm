// GET /api/studio-management/ac/devices/[id]
//
//   Device row + cached live state (or ?live=1 for a vendor read), gated per
//   device by the dispatcher (loadDeviceForUser). Polled by the web control
//   panel and the phone.
//
// ACDEVLOC.1 — PATCH (edit) and DELETE (disable) moved to
// PATCH /api/locations/[id]/ac-devices/[deviceId], which acts on the path
// location and can re-enable a disabled unit (this route's loadDeviceForUser
// refuses one with 409, so Re-enable never worked from here).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getState as dispatchGetState, loadDeviceForUser } from '@/lib/ac-devices'
import { AC_SESSION_ACTIVE_STATUSES } from '@/lib/enums'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ---- GET ----

export const GET = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, params, request }) => {
    // SENSIBO-RATE.1 — served from ac_devices.last_state by default.
    //
    // This route used to hit the vendor LIVE on every request, and
    // both AcControlPanel.jsx and mobile's AcDeviceList.jsx poll it
    // every 30s per device card with no visibility gating — so every
    // open panel was a permanent 2 vendor calls/minute. Sensibo
    // rate-limits on bursts (~4 calls in 1.6s = 429, block >75s), so
    // that background load left no budget for the crons that
    // actually need to act, and the gym-floor unit stopped
    // auto-offing from 2026-08-29.
    //
    // The cache is refreshed by the ac-external-rule cron (which
    // already polls every device every 5 min) and written
    // immediately by every CRM-initiated power change, so an action
    // taken here shows up at once. Only a change made on the wall
    // panel or in the vendor's own app lags, by at most one tick.
    //
    // `?live=1` forces a real vendor read for a deliberate operator
    // refresh. It goes through the same limiter as everything else.
    const wantsLive = new URL(request.url).searchParams.get('live') === '1'

    // Either path runs loadDeviceForUser first, so the per-device
    // permission gate is enforced before anything else happens.
    const out = wantsLive
      ? await dispatchGetState(params?.id, { user, db })
      : await loadDeviceForUser(params?.id, { user, db })
    if (!out.ok) {
      return NextResponse.json(
        { success: false, error: out.error, code: out.code },
        { status: out.status || 500 }
      )
    }
    const state = wantsLive ? out.state : (out.device.last_state ?? null)
    const stateAsOf = wantsLive ? new Date().toISOString() : (out.device.last_state_at ?? null)

    // Active session for this device, if any. The panel uses it to
    // render the countdown timer + "started by X" line. We do this
    // here (rather than inside the dispatcher) so the dispatcher
    // stays pure-side-effect-on-mutation; reads stay route-shaped.
    const { data: activeRows } = await db
      .from('ac_sessions')
      .select('id, started_at, auto_off_at, status, started_by, profiles:started_by(full_name)')
      .eq('device_id', out.device.id)
      .in('status', AC_SESSION_ACTIVE_STATUSES)
      .order('started_at', { ascending: false })
      .limit(1)
    const activeSession = activeRows?.[0] || null

    // STUDIO-AC-EXTERNAL-RULE.1 — surface the external-start row
    // if one exists. The cron maintains this table; the panel
    // reads it to show "Started externally · auto-off at HH:MM"
    // instead of just "Running". null when the unit isn't running
    // externally, when the rule is disabled for this device, or
    // when the cron hasn't observed it yet (up to one tick lag).
    const { data: externalStartRow } = await db
      .from('ac_external_starts')
      .select('first_seen_at, expected_off_at')
      .eq('device_id', out.device.id)
      .maybeSingle()

    return NextResponse.json({
      success: true,
      data: {
        device: out.device,
        state,
        // When the reading was taken. null = never observed yet (the
        // next ac-external-rule tick fills it in). The panel can use
        // this to say "as of HH:MM" rather than implying it's live.
        state_as_of: stateAsOf,
        active_session: activeSession,
        external_start: externalStartRow || null,
      },
    })
  }
)
