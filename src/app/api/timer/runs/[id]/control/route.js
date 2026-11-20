// POST /api/timer/runs/[id]/control  — { action: pause|resume|skip|stop, direction? }
//
// CLASS-TIMER. Gated by the `class_timer` permission (CLASS-TIMER-PERM.1).
// Loads the run, applies the pure transition (class-timer.js nextRunState),
// persists. No-op actions return the run unchanged.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { broadcastTimerPing } from '@/lib/timer-broadcast'
import { nextRunState, buildTimeline } from '@/lib/class-timer'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ControlSchema = z.object({
  action: z.enum(['pause', 'resume', 'skip', 'stop']),
  direction: z.enum(['next', 'prev']).optional(),
})

// `class_timer` somewhere (403 'Unauthorized'), the body (400), the run's
// studio (404) and `class_timer` there (403), as before. A signed-out call is
// a 401 now.
export const POST = withAuth(
  { permission: null, location: false, allow: (user) => hasPermissionAtAnyLocation(user, 'class_timer'), forbiddenMessage: 'Unauthorized' },
  async ({ user, db, request, params }) => {
    const id = params?.id
    const validation = await validateBody(request, ControlSchema)
    if (!validation.ok) return validation.response
    const { action, direction } = validation.data

    const { data: run } = await db
      .from('class_timer_runs')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (!run || assertLocationAccess(user, run.location_id)) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    // ROLESWEEP.1a — the permission is judged at the run's location.
    if (!hasPermissionForLocation(user, run.location_id, 'class_timer')) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
    }

    const timeline = action === 'skip' ? buildTimeline(run.structure_snapshot) : null
    const patch = nextRunState(run, action, Date.now(), { direction, timeline })
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: true, run })
    }

    const { data, error } = await db
      .from('class_timer_runs')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', run.id)
      .select('*')
      .single()
    if (error) {
      logError('class-timer', 'run control failed', { runId: run.id, action, err: error })
      return NextResponse.json({ success: false, error: 'Could not update the timer. Try again.' }, { status: 500 })
    }
    await broadcastTimerPing(run.location_id)
    return NextResponse.json({ success: true, run: data })
  },
)
