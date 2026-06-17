// GET /api/automations/[key]/history?location_id=<uuid>&limit=25
//
// CLASS-CLIMATE.6 — run history for a schedule-driven automation: the
// recent automation_fire_log rows (what it turned on / skipped / failed,
// for which class + device, when). Gives the operator visibility into the
// autonomous cron firings, not just the on-demand "Run schedule check now".
// Read-only; manager-gated; works for any automation key (class_climate is
// the only writer today).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { key } = await params

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '25', 10) || 25, 1), 100)

  const db = createServerClient()
  const { data, error } = await db
    .from('automation_fire_log')
    .select('glofox_event_id, device_id, action_step, status, detail, fired_at')
    .eq('automation_key', key)
    .eq('location_id', locationId)
    .order('fired_at', { ascending: false })
    .limit(limit)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // Resolve device labels with a small separate lookup (avoids a PostgREST
  // embed; the device set is tiny).
  const deviceIds = [...new Set((data || []).map((r) => r.device_id).filter(Boolean))]
  let labels = {}
  if (deviceIds.length) {
    const { data: devs } = await db.from('ac_devices').select('id, label').in('id', deviceIds)
    labels = Object.fromEntries((devs || []).map((d) => [d.id, d.label]))
  }

  const items = (data || []).map((r) => ({
    glofox_event_id: r.glofox_event_id,
    device_label: r.device_id ? (labels[r.device_id] || null) : null,
    action: r.action_step,
    status: r.status,
    class_name: r.detail?.class_name || null,
    reason: r.detail?.reason || null,
    error: r.detail?.error || null,
    fired_at: r.fired_at,
  }))
  return NextResponse.json({ success: true, items })
}
