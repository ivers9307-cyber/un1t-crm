// /api/races/[id]
//
// Single-race read / update / soft-delete (active=false). Manager+
// at the race's location.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  registration_opens_at: z.string().datetime().nullable().optional(),
  registration_closes_at: z.string().datetime().nullable().optional(),
  capacity: z.number().int().positive().max(10000).nullable().optional(),
  allowed_team_sizes: z.array(z.number().int().positive().max(50)).min(1).max(20).optional(),
  active: z.boolean().optional(),
})

async function loadRace(db, id) {
  return db
    .from('race_events')
    .select(`
      id, location_id, name, slug, description, race_date, start_time,
      registration_opens_at, registration_closes_at, capacity,
      allowed_team_sizes, active, created_at, updated_at,
      registrations:race_registrations (
        id, status, race_started_at, race_finished_at, registered_at,
        teams ( id, name, size, captain_contact_id,
          team_members ( id, name, email, role )
        )
      )
    `)
    .eq('id', id)
    .single()
}

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data, error } = await loadRace(db, params.id)
  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, data.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  return NextResponse.json({ success: true, data })
}

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const validation = await validateBody(request, UpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: existing, error: lookupErr } = await db
    .from('race_events')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (lookupErr || !existing) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, existing.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const updates = { ...body }
  if (Array.isArray(updates.allowed_team_sizes)) {
    updates.allowed_team_sizes = [...updates.allowed_team_sizes].sort((a, b) => a - b)
  }
  // Strip undefined so Supabase doesn't try to write them.
  for (const k of Object.keys(updates)) if (updates[k] === undefined) delete updates[k]

  const { data, error } = await db
    .from('race_events')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

export async function DELETE(_request, { params }) {
  // Soft delete via active=false — preserves race_registrations
  // for historical record.
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: existing } = await db
    .from('race_events')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (!existing) return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  const guard = assertLocationAccess(user, existing.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const { error } = await db
    .from('race_events')
    .update({ active: false })
    .eq('id', params.id)

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
