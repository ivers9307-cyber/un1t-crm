// GET /api/timer/active?location_id=<uuid>  — the live timer run for the
// control UIs.
//
// SEC-LIVE-API.1 — auth: a member of the location holding `class_timer` there.
// This was the one route in the timer family with no permission check (it was
// written to mirror the then-ungated /api/live/[locationId]); its four
// siblings and the /studio-management/timer page all require `class_timer`.
// No floor risk: `class_timer` defaults TRUE for every role, the studio TV
// reads timer state from the public board payload (/api/public/live) rather
// than this route, and the mobile timer screen is gated on the same key.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { resolveCurrentOccurrence } from '@/lib/class-occurrences'
import { matchTemplateToClassName, buildTimeline, computeEffectiveElapsedMs, resolveTimerState } from '@/lib/class-timer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Location not in your scope' }, { status: 403 })
  }
  if (!hasPermissionForLocation(user, locationId, 'class_timer')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()
  const { data } = await db
    .from('class_timer_runs')
    .select('*')
    .eq('location_id', locationId)
    .in('status', ['running', 'paused'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Auto-stop a finished run so the TV doesn't stick on "Complete" forever.
  let activeRun = data
  if (activeRun && activeRun.status === 'running' && activeRun.structure_snapshot) {
    const timeline = buildTimeline(activeRun.structure_snapshot)
    const st = resolveTimerState(timeline, computeEffectiveElapsedMs(activeRun, Date.now()))
    if (st.finished) {
      await db.from('class_timer_runs').update({ status: 'finished' }).eq('id', activeRun.id)
      activeRun = null
    }
  }

  // CLASS-TIMER PR4 — when nothing is running, surface the Glofox class that's
  // live now (off the class_occurrences spine) and the template tagged for it,
  // so the control UIs can offer a one-tap "DR1VE is live → load its timer?".
  // Skipped while a run is active (the suggestion would be moot).
  let liveClass = null
  let suggestedTemplate = null
  if (!activeRun) {
    const occ = await resolveCurrentOccurrence(db, { locationId })
    if (occ?.class_name) {
      liveClass = { class_name: occ.class_name }
      const { data: templates } = await db
        .from('class_timer_templates')
        .select('id, name, total_seconds, glofox_program')
        .eq('location_id', locationId)
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
      const match = matchTemplateToClassName(templates || [], occ.class_name)
      if (match) suggestedTemplate = { id: match.id, name: match.name, total_seconds: match.total_seconds }
    }
  }

  return NextResponse.json({ success: true, run: activeRun, live_class: liveClass, suggested_template: suggestedTemplate })
}
