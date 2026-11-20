// GET /api/automations/[key]/history?location_id=<uuid>&limit=25
//
// CLASS-CLIMATE.6 — run history for a schedule-driven automation: the
// recent automation_fire_log rows (what it turned on / skipped / failed,
// for which class + device, when). Gives the operator visibility into the
// autonomous cron firings, not just the on-demand "Run schedule check now".
// Read-only; manager-gated; works for any automation key (class_climate is
// the only writer today).

import { NextResponse } from 'next/server'
import { assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ROLESWEEP.1a — coarse pre-check (a manager-tier role somewhere, the same
// 'Unauthorized' 403); the role is judged at the location below. A signed-out
// call is withAuth's 401 (it was this 403).
export const GET = withAuth({
  permission: null, location: false,
  allow: (user) => hasRoleAtAnyLocation(user, MANAGER_ROLES), forbiddenMessage: 'Unauthorized',
}, async ({ request, user, db, params }) => {
  const { key } = params

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '25', 10) || 25, 1), 100)

  const { data, error } = await db
    .from('automation_fire_log')
    .select('glofox_event_id, device_id, action_step, status, detail, fired_at')
    .eq('automation_key', key)
    .eq('location_id', locationId)
    .order('fired_at', { ascending: false })
    .limit(limit)
  if (error) {
    logError('automations', 'history read failed', { key, locationId, err: error })
    return NextResponse.json({ success: false, error: 'Could not load the run history.' }, { status: 500 })
  }

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
})
