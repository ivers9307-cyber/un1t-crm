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
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { getState as dispatchGetState, loadDeviceForUser } from '@/lib/ac-devices'
import { AC_SESSION_ACTIVE_STATUSES } from '@/lib/enums'
import { validateBody } from '@/lib/validate'

const AcDevicePatchSchema = z.object({
  label: z.string().optional(),
  device_group: z.string().nullable().optional(),
  default_mode: z.string().optional(),
  default_temp_c: z.union([z.number(), z.string()]).optional(),
  default_fan: z.string().optional(),
  session_minutes: z.union([z.number(), z.string()]).optional(),
  external_auto_off_minutes: z.union([z.number(), z.string()]).nullable().optional(),
  enabled: z.boolean().optional(),
}).passthrough()

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

    const validation = await validateBody(request, AcDevicePatchSchema)
    if (!validation.ok) return validation.response
    const body = validation.data

    // Whitelist of editable columns. Anything not in here is silently
    // ignored — we never let the operator overwrite provider /
    // provider_device_id / location_id (which would corrupt the
    // device's identity).
    const patch = {}
    for (const key of [
      'label', 'device_group',
      'default_mode', 'default_temp_c', 'default_fan',
      'session_minutes',
      'external_auto_off_minutes',  // STUDIO-AC-EXTERNAL-RULE.1
      'enabled',
    ]) {
      if (key in body) patch[key] = body[key]
    }
    // Normalise device_group: trim, treat empty string as null so a
    // master clearing the field unsets the group rather than saving
    // an empty-string sentinel (which would render as its own
    // section in the panel).
    if ('device_group' in patch) {
      const v = String(patch.device_group ?? '').trim()
      patch.device_group = v || null
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: false, error: 'No editable fields supplied.' }, { status: 400 })
    }
    if ('default_temp_c'  in patch) patch.default_temp_c  = Number(patch.default_temp_c)
    if ('session_minutes' in patch) patch.session_minutes = Number(patch.session_minutes)
    // external_auto_off_minutes — allow null (master clearing the
    // field to disable the rule for this device). Empty string,
    // null, undefined → null. Otherwise coerce to integer.
    if ('external_auto_off_minutes' in patch) {
      const raw = patch.external_auto_off_minutes
      if (raw === null || raw === '' || raw === undefined) {
        patch.external_auto_off_minutes = null
      } else {
        const n = Number(raw)
        patch.external_auto_off_minutes = Number.isFinite(n) && n > 0 ? Math.round(n) : null
      }
    }

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
