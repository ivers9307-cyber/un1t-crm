// /api/studio-management/ac/devices/[id]
//
//   GET    → device row + live state (or null/error if vendor
//            unreachable). Permission-gated via the dispatcher.
//   PATCH  → master-only: rename, change defaults, enable/disable.
//            Body keys: label, default_mode, default_temp_c,
//            default_fan, session_minutes, enabled.
//   DELETE → master-only: soft-disable (set enabled=false). Hard
//            delete only via DB — keeps audit trail intact for
//            past sessions.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getState as dispatchGetState, loadDeviceForUser } from '@/lib/ac-devices'
import { AC_SESSION_ACTIVE_STATUSES } from '@/lib/enums'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ---- GET ----

export const GET = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, params }) => {
    // dispatchGetState runs loadDeviceForUser internally, so the
    // permission gate is enforced before we touch the vendor.
    const out = await dispatchGetState(params?.id, { user, db })
    if (!out.ok) {
      return NextResponse.json(
        { success: false, error: out.error, code: out.code },
        { status: out.status || 500 }
      )
    }

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

    return NextResponse.json({
      success: true,
      data: {
        device: out.device,
        state: out.state,
        active_session: activeSession,
      },
    })
  }
)

// ---- PATCH ----

export const PATCH = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, params, request }) => {
    if (user.role !== 'master') {
      return NextResponse.json(
        { success: false, error: 'Only master can edit AC devices.' },
        { status: 403 }
      )
    }
    // Master needs to have access to the device's location, which
    // is implicit (master sees every location). We still pass
    // through loadDeviceForUser so the device id is validated and
    // exists at all.
    const loaded = await loadDeviceForUser(params?.id, { user, db })
    if (!loaded.ok) {
      return NextResponse.json(
        { success: false, error: loaded.error, code: loaded.code },
        { status: loaded.status || 500 }
      )
    }

    let body
    try { body = await request.json() }
    catch { return NextResponse.json({ success: false, error: 'Invalid JSON body.' }, { status: 400 }) }

    // Whitelist of editable columns. Anything not in here is silently
    // ignored — we never let the operator overwrite provider /
    // provider_device_id / location_id (which would corrupt the
    // device's identity).
    const patch = {}
    for (const key of ['label', 'default_mode', 'default_temp_c', 'default_fan', 'session_minutes', 'enabled']) {
      if (key in body) patch[key] = body[key]
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: false, error: 'No editable fields supplied.' }, { status: 400 })
    }
    if ('default_temp_c'  in patch) patch.default_temp_c  = Number(patch.default_temp_c)
    if ('session_minutes' in patch) patch.session_minutes = Number(patch.session_minutes)

    const { data: row, error: updErr } = await db
      .from('ac_devices')
      .update(patch)
      .eq('id', params.id)
      .select()
      .single()
    if (updErr) {
      return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: row })
  }
)

// ---- DELETE ----

export const DELETE = withAuth(
  { permission: 'studio_management' },
  async ({ user, db, params }) => {
    if (user.role !== 'master') {
      return NextResponse.json(
        { success: false, error: 'Only master can remove AC devices.' },
        { status: 403 }
      )
    }
    // Soft-disable. Sessions referencing this device keep their FK
    // intact, so /admin/audit-log can still resolve the device
    // label for historical events.
    const { error: updErr } = await db
      .from('ac_devices')
      .update({ enabled: false })
      .eq('id', params?.id)
    if (updErr) {
      return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  }
)
