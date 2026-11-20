// POST /api/timer/runs  — start a timer run from a template.
//
// CLASS-TIMER. Gated by the `class_timer` permission (CLASS-TIMER-PERM.1 —
// every role by default so coaches on shift can run the timer). Snapshots the
// template structure, finalises any live run at the location (one-live-run
// invariant), inserts a running run.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess } from '@/lib/auth'
import { logError } from '@/lib/log'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { broadcastTimerPing } from '@/lib/timer-broadcast'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const StartSchema = z.object({
  location_id: uuidLike,
  template_id: uuidLike,
})

// withAuth only signs the caller in (signed out: its 401, it was this 403);
// class_timer somewhere, then at the body's studio, runs here as before.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  if (!hasPermissionAtAnyLocation(user, 'class_timer')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const validation = await validateBody(request, StartSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, body.location_id, 'class_timer')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { data: template } = await db
    .from('class_timer_templates')
    .select('id, location_id, name, structure')
    .eq('id', body.template_id)
    .maybeSingle()
  if (!template || template.location_id !== body.location_id) {
    return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
  }

  // Finalise any live run at this location first (the partial unique index
  // allows only one running|paused row per location).
  await db
    .from('class_timer_runs')
    .update({ status: 'stopped', updated_at: new Date().toISOString() })
    .eq('location_id', body.location_id)
    .in('status', ['running', 'paused'])

  const nowIso = new Date().toISOString()
  const { data, error } = await db
    .from('class_timer_runs')
    .insert({
      location_id: body.location_id,
      template_id: template.id,
      structure_snapshot: template.structure,
      name: template.name,
      status: 'running',
      started_at: nowIso,
      started_by: user.id,
    })
    .select('*')
    .single()
  if (error) {
    logError('class-timer', 'run start failed', { locationId: body.location_id, code: error.code ?? null, message: error.message })
    return NextResponse.json({ success: false, error: 'Could not start the timer just now.' }, { status: 500 })
  }
  await broadcastTimerPing(body.location_id)
  return NextResponse.json({ success: true, run: data })
})
