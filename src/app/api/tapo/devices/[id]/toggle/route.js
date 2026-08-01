// POST /api/tapo/devices/[id]/toggle
//
// TAPO-T1.4 — staff manual override for one Tapo device. Sets (or
// clears) the `override` blob the desired-state engine honours ahead
// of any schedule:
//
//   { state: 'on' | 'off', until?: ISO }   → force that state until
//                                             `until` (defaults to end
//                                             of the Dublin day)
//   { clear: true }                         → drop the override, hand
//                                             control back to the
//                                             schedule
//
// Exactly one of `state` / `clear` is required. The bridge picks the
// change up on its next reconcile tick.
//
// NOT implemented in T1: the spec's "toggling to the scheduled state
// clears the override" behaviour — that needs the live desiredState
// (occurrences included) computed here, deferred to T2/T3. Toggle
// always writes an override; only an explicit `clear` removes it.
//
// Service-role route: authorize in app code — getCurrentUser (401) →
// hasPermission (403) → uuidLike guard (404) → load + cross-location
// 404 (no ID enumeration). Audit is fire-and-forget: a logging
// failure must never fail the toggle.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'
import { dublinDayStartMs, dublinTodayStr, addDaysISO } from '@/lib/dublin-time'
import { logWarn } from '@/lib/log'
import { getHomeyConfig, homeySetOnoff } from '@/lib/homey/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  state: z.enum(['on', 'off']).optional(),
  clear: z.boolean().optional(),
  until: z.string().datetime().optional(),
})
  .refine(
    (b) => (b.state != null) !== (b.clear === true),
    { message: 'Provide exactly one of `state` or `clear`.' }
  )
  .refine(
    (b) => {
      if (!b.until) return true
      const ms = Date.parse(b.until)
      return Number.isFinite(ms) && ms > Date.now()
    },
    { message: '`until` must be a valid ISO datetime in the future.', path: ['until'] }
  )

export async function POST(request, props) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const params = await props.params
  if (!uuidLike.safeParse(params?.id).success) {
    return NextResponse.json({ success: false, error: 'Device not found' }, { status: 404 })
  }

  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const db = createServerClient()
  try {
    const { data: row, error: loadErr } = await db
      .from('tapo_devices')
      .select('id, location_id, name')
      .eq('id', params.id)
      .maybeSingle()
    if (loadErr) {
      return NextResponse.json({ success: false, error: loadErr.message }, { status: 500 })
    }
    if (!row || row.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Device not found' }, { status: 404 })
    }

    const validation = await validateBody(request, Body)
    if (!validation.ok) return validation.response
    const { state, clear, until } = validation.data

    let override = null
    if (!clear) {
      // Default expiry = end of the Dublin day (start of tomorrow,
      // Dublin wall-clock). Keeps a "turn it on now" override from
      // sticking indefinitely if staff forget to clear it.
      // dublinDayStartMs(tomorrow) is DST-exact — a flat +24h lands
      // at 23:00/01:00 on the two transition days.
      const untilIso = until || new Date(dublinDayStartMs(addDaysISO(dublinTodayStr(), 1))).toISOString()
      override = { state, until: untilIso, set_by: user.id }
    }

    const { data: updated, error: updErr } = await db
      .from('tapo_devices')
      .update({ override, updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .select('*')
      .single()
    if (updErr) {
      return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
    }

    // Best-effort audit row (mirrors studio-management/unlock). The
    // override is already written — a logging failure must not fail
    // the response.
    db.from('activities').insert({
      kind: 'event',
      type: 'device_toggle',
      title: clear
        ? `Cleared override on ${row.name || 'device'}`
        : `Set ${row.name || 'device'} ${state}`,
      profile_id: user.id,
      location_id: locationId,
    }).then(() => {}).catch((e) => {
      logWarn('tapo-toggle', 'activity log failed', { err: e })
    })

    // Fire the command directly for instant feedback; the per-minute
    // homey-reconcile cron is the backstop if this call fails. Only when
    // this toggle set a concrete on/off — a `clear` hands control back
    // to the schedule, and figuring out what the schedule wants right
    // now is runHomeyReconcile's job (desiredState + occurrences), not
    // this route's; don't recompute it here.
    if (!clear) {
      try {
        const cfg = getHomeyConfig()
        // Scope to the configured Homey's location — the cron only ever
        // commands cfg.locationId devices; a second studio's toggle must
        // not PUT against this Homey.
        if (cfg && !cfg.error && cfg.locationId === locationId && updated.sidecar_device_id) {
          // homeySetOnoff resolves rather than rejects by contract, but
          // belt-and-braces per house style: never let this block or
          // change the toggle response.
          homeySetOnoff(cfg, updated.sidecar_device_id, state === 'on').catch(() => {})
        }
      } catch { /* never blocks the toggle response */ }
    }

    return NextResponse.json({ success: true, device: updated })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || String(e) }, { status: 500 })
  }
}
