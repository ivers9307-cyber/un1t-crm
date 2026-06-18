// POST /api/timer/runs  — start a timer run from a template.
//
// CLASS-TIMER. Manager-gated. Snapshots the template structure, finalises any
// live run at the location (one-live-run invariant), inserts a running run.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const StartSchema = z.object({
  location_id: uuidLike,
  template_id: uuidLike,
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const validation = await validateBody(request, StartSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard

  const db = createServerClient()
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
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, run: data })
}
