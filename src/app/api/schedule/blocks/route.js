// /api/schedule/blocks
//
// Roster v2 phase 2 — block-shaped read endpoint for the schedule
// calendar. Returns each shift_block with its template + nested
// assignments (each joined to the assigned profile). Empty blocks
// come through as rows with assignments: [].
//
// Replaces the calendar's previous use of /api/schedule/shifts.
// The legacy /shifts endpoint stays in place because mobile + the
// report generator still consume that shape — the mig 068 trigger
// keeps the legacy public.shifts table mirrored from new writes.
//
// POST is for manual block creation (rare — most blocks are
// auto-generated when a template's days_of_week is saved).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate, timeOfDay, MANAGER_ROLES } from '@/lib/schemas'

const BlockCreateSchema = z.object({
  location_id: uuidLike,
  template_id: uuidLike,
  block_date: isoDate,
  start_time: timeOfDay.optional(),
  end_time: timeOfDay.optional(),
  max_coaches: z.number().int().min(1).max(50).optional(),
  notes: z.string().max(2000).nullable().optional(),
})

// GET /api/schedule/blocks?location_id=...&start_date=...&end_date=...
export async function GET(request) {
  const user = await getCurrentUser()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const startDate = searchParams.get('start_date')
  const endDate = searchParams.get('end_date')
  const db = createServerClient()

  let query = db
    .from('shift_blocks')
    .select(`
      *,
      shift_templates(id, name, color, role_label, start_time, end_time, days_of_week, max_coaches),
      shift_assignments(
        id,
        profile_id,
        notes,
        status,
        assigned_at,
        profiles:profile_id(id, full_name, email, avatar_url, role)
      )
    `)
    .order('block_date')
    .order('start_time')

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) {
      return NextResponse.json({ success: true, data: [] })
    }
    query = query.in('location_id', userLocationIds)
  }
  if (startDate) query = query.gte('block_date', startDate)
  if (endDate) query = query.lte('block_date', endDate)

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }
  return NextResponse.json({ success: true, data })
}

// POST /api/schedule/blocks — manual block creation. Most blocks
// come from the auto-generator when a template is saved; this
// endpoint exists for one-off "I need an extra slot on this Saturday"
// cases.
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, BlockCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard

  const db = createServerClient()

  // If start/end weren't supplied, snapshot from the template.
  let start = body.start_time
  let end = body.end_time
  let max = body.max_coaches
  if (!start || !end || !max) {
    const { data: tpl, error: tplErr } = await db
      .from('shift_templates')
      .select('start_time, end_time, max_coaches')
      .eq('id', body.template_id)
      .single()
    if (tplErr || !tpl) {
      return NextResponse.json(
        { success: false, error: 'Template not found' },
        { status: 400 }
      )
    }
    start = start || tpl.start_time
    end = end || tpl.end_time
    max = max || tpl.max_coaches || 15
  }

  const { data, error } = await db
    .from('shift_blocks')
    .insert({
      location_id: body.location_id,
      template_id: body.template_id,
      block_date: body.block_date,
      start_time: start,
      end_time: end,
      max_coaches: max,
      notes: body.notes || null,
      created_by: user.id,
    })
    .select(`
      *,
      shift_templates(id, name, color, role_label, start_time, end_time, days_of_week, max_coaches),
      shift_assignments(
        id, profile_id, notes, status, assigned_at,
        profiles:profile_id(id, full_name, email, avatar_url, role)
      )
    `)
    .single()

  if (error) {
    // Friendlier error for the duplicate-key case.
    if (error.code === '23505') {
      return NextResponse.json(
        { success: false, error: 'A block already exists for this template on this date.' },
        { status: 409 }
      )
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }
  return NextResponse.json({ success: true, data }, { status: 201 })
}
