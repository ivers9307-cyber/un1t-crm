// GET  /api/timer/templates?location_id=<uuid>   — list active templates
// POST /api/timer/templates                       — create a template
//
// CLASS-TIMER — reusable interval-timer templates. Gated by the `class_timer`
// permission (CLASS-TIMER-PERM.1 — the quick-add preset flow POSTs here, so
// template create shares the run-control gate).

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { assertLocationAccess } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { validateStructure, buildTimeline } from '@/lib/class-timer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateSchema = z.object({
  location_id: uuidLike,
  name: z.string().min(1).max(80),
  structure: z.array(z.any()).min(1),
  glofox_program: z.string().max(120).nullish(),
})

// withAuth signs the caller in (signed out is its 401); the class_timer checks
// run below in their old order with their old words.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  if (!hasPermissionAtAnyLocation(user, 'class_timer')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'class_timer')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { data, error } = await db
    .from('class_timer_templates')
    .select('id, name, structure, total_seconds, glofox_program, updated_at')
    .eq('location_id', locationId)
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
  if (error) {
    logError('timer-templates', 'template list read failed', { locationId, err: error })
    return NextResponse.json({ success: false, error: 'Could not read the timer templates.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, templates: data || [] })
})

export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  if (!hasPermissionAtAnyLocation(user, 'class_timer')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, body.location_id, 'class_timer')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const v = validateStructure(body.structure)
  if (!v.ok) return NextResponse.json({ success: false, error: v.error }, { status: 400 })
  const total_seconds = Math.round(buildTimeline(body.structure).totalMs / 1000)

  const { data, error } = await db
    .from('class_timer_templates')
    .insert({
      location_id: body.location_id,
      name: body.name,
      structure: body.structure,
      total_seconds,
      glofox_program: body.glofox_program ?? null,
      created_by: user.id,
    })
    .select('id, name, structure, total_seconds, glofox_program, updated_at')
    .single()
  if (error) {
    logError('timer-templates', 'template insert failed', { locationId: body.location_id, err: error })
    return NextResponse.json({ success: false, error: 'Could not save the timer template.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, template: data })
})
