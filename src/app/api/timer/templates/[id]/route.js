// GET    /api/timer/templates/[id]   — one template
// PUT    /api/timer/templates/[id]   — update (re-validate structure)
// DELETE /api/timer/templates/[id]   — soft-delete (is_active=false)
//
// CLASS-TIMER. Gated by the `class_timer` permission (CLASS-TIMER-PERM.1);
// loads the row first and checks location access, returning 404 (not 403) on
// a missing/foreign row so ids can't be enumerated.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { validateStructure, buildTimeline } from '@/lib/class-timer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  structure: z.array(z.any()).min(1).optional(),
  glofox_program: z.string().max(120).nullish(),
})

async function loadOwned(db, user, id) {
  const { data: row } = await db
    .from('class_timer_templates')
    .select('id, location_id, name, structure, total_seconds, glofox_program')
    .eq('id', id)
    .maybeSingle()
  if (!row) return { notFound: true }
  if (assertLocationAccess(user, row.location_id)) return { notFound: true }
  return { row }
}

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'class_timer')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const { id } = await params
  const db = createServerClient()
  const { row, notFound } = await loadOwned(db, user, id)
  if (notFound) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, template: row })
}

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'class_timer')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const { id } = await params
  const validation = await validateBody(request, UpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { row, notFound } = await loadOwned(db, user, id)
  if (notFound) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const updates = { updated_at: new Date().toISOString() }
  if (body.name !== undefined) updates.name = body.name
  if (body.glofox_program !== undefined) updates.glofox_program = body.glofox_program
  if (body.structure !== undefined) {
    const v = validateStructure(body.structure)
    if (!v.ok) return NextResponse.json({ success: false, error: v.error }, { status: 400 })
    updates.structure = body.structure
    updates.total_seconds = Math.round(buildTimeline(body.structure).totalMs / 1000)
  }

  const { data, error } = await db
    .from('class_timer_templates')
    .update(updates)
    .eq('id', row.id)
    .select('id, name, structure, total_seconds, glofox_program, updated_at')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, template: data })
}

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'class_timer')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const { id } = await params
  const db = createServerClient()
  const { row, notFound } = await loadOwned(db, user, id)
  if (notFound) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const { error } = await db
    .from('class_timer_templates')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', row.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
