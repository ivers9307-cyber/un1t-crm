// POST /api/timer/runs/[id]/control  — { action: pause|resume|skip|stop, direction? }
//
// CLASS-TIMER. Manager-gated. Loads the run, applies the pure transition
// (class-timer.js nextRunState), persists. No-op actions return the run unchanged.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { nextRunState, buildTimeline } from '@/lib/class-timer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ControlSchema = z.object({
  action: z.enum(['pause', 'resume', 'skip', 'stop']),
  direction: z.enum(['next', 'prev']).optional(),
})

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const { id } = await params
  const validation = await validateBody(request, ControlSchema)
  if (!validation.ok) return validation.response
  const { action, direction } = validation.data

  const db = createServerClient()
  const { data: run } = await db
    .from('class_timer_runs')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (!run || assertLocationAccess(user, run.location_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
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
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, run: data })
}
