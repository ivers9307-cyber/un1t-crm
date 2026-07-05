// src/app/api/bridge/tapo/directives/route.js
//
// TAPO-T1 — the Pi's reconciliation loop pulls this every ~15s.
// Returns every enabled+managed device with its desired state NOW
// plus the whole day's resolved windows so the bridge can keep
// executing fixed AND class schedules through a CRM/internet outage.
// `desired` is a convenience for the current tick; `resolved_windows`
// is the source of truth for offline continuity.
import { NextResponse } from 'next/server'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { createServerClient } from '@/lib/supabase'
import { dublinTodayStr, dublinDayStartMs, addDaysISO } from '@/lib/dublin-time'
import { resolveServeWindows, desiredState } from '@/lib/tapo/desired-state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const bridge = await verifyBridgeToken(request)
  if (!bridge) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const locationId = bridge.locationId

  const today = dublinTodayStr()
  const dayStart = new Date(dublinDayStartMs(today)).toISOString()
  // Today's Dublin day EXACTLY (DST-exact next-midnight bound, not a flat
  // +24h/+36h). Pulling tomorrow's occurrences in would be a real bug: class
  // mode collapses ALL occurrences into ONE window (min(starts)−lead →
  // max(ends)+lag), so tomorrow's 06:00 class would hold class-linked devices
  // ON all night, every night. Fixed windows never consume occurrences, and a
  // class STARTING today but ending after midnight still spills forward
  // correctly because off_at = ends+lag regardless of date.
  const dayEnd = new Date(dublinDayStartMs(addDaysISO(today, 1))).toISOString()

  const [{ data: devices, error: e1 }, { data: occurrences, error: e2 }] = await Promise.all([
    db.from('tapo_devices').select('*').eq('location_id', locationId).eq('enabled', true).limit(200),
    db.from('class_occurrences').select('starts_at, ends_at, cancelled_at')
      .eq('location_id', locationId).gte('starts_at', dayStart).lt('starts_at', dayEnd)
      .is('cancelled_at', null).limit(500),
  ])
  if (e1 || e2) return NextResponse.json({ success: false, error: (e1 || e2).message }, { status: 500 })

  const now = Date.now()
  const out = (devices || [])
    .filter(d => d.schedule_mode !== 'none' || d.override)
    .map(d => ({
      sidecar_device_id: d.sidecar_device_id,
      desired: desiredState(d, now, today, occurrences || []),
      // resolved_windows is a MEMBERSHIP SET — the bridge decides on/off by asking
      // "is now inside ANY of these windows?", never by replaying them as a queue of
      // discrete on/off events. Overlapping windows are returned unmerged; treating
      // them as an event stream would double-toggle across an overlap.
      // resolveServeWindows = today's windows ∪ yesterday's still-live fixed
      // overnight tails, so a Sat 22:00–02:00 window survives Sunday midnight
      // in the bridge's offline set too.
      resolved_windows: resolveServeWindows(d, today, occurrences || [])
        .map(w => ({ on_at: new Date(w.on_at).toISOString(), off_at: new Date(w.off_at).toISOString() })),
      override_until: d.override?.until || null,
    }))
    .filter(d => d.desired !== null || d.resolved_windows.length > 0)

  return NextResponse.json({ success: true, date: today, devices: out })
}
