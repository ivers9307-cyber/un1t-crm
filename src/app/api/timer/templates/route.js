// GET  /api/timer/templates?location_id=<uuid>   — list active templates
// POST /api/timer/templates                       — create a template
//
// CLASS-TIMER — reusable interval-timer templates. Manager-gated.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { validateStructure, buildTimeline } from '@/lib/class-timer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateSchema = z.object({
  location_id: uuidLike,
  name: z.string().min(1).max(80),
  structure: z.array(z.any()).min(1),
  glofox_program: z.string().max(120).nullish(),
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db
    .from('class_timer_templates')
    .select('id, name, structure, total_seconds, glofox_program, updated_at')
    .eq('location_id', locationId)
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, templates: data || [] })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard

  const v = validateStructure(body.structure)
  if (!v.ok) return NextResponse.json({ success: false, error: v.error }, { status: 400 })
  const total_seconds = Math.round(buildTimeline(body.structure).totalMs / 1000)

  const db = createServerClient()
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
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, template: data })
}
