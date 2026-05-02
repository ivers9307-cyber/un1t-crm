// /api/schedule/blocks/[id]/assignments — POST
//
// Assigns a coach to a shift_block. The mig 068 trigger mirrors
// the new assignment row into the legacy public.shifts table so
// mobile + reports keep seeing the data.
//
// Capacity (block.max_coaches) is enforced at this layer, not via
// CHECK — admin overrides ("we really do need a 16th coach today")
// stay possible by passing { allow_over_capacity: true }.
//
// Time-off conflicts are surfaced as a warning (same pattern the
// legacy /api/schedule/shifts POST uses), not a hard block.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'

const AssignSchema = z.object({
  profile_id: uuidLike,
  notes: z.string().max(2000).nullable().optional(),
  allow_over_capacity: z.boolean().optional(),
})

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, AssignSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()

  // Block lookup — also our location-ownership gate.
  const { data: block, error: blockErr } = await db
    .from('shift_blocks')
    .select('id, location_id, block_date, max_coaches, shift_assignments(count)')
    .eq('id', params.id)
    .single()

  if (blockErr || !block) {
    return NextResponse.json({ success: false, error: 'Block not found' }, { status: 404 })
  }

  if (user.role !== 'master') {
    const userLocationIds = getUserLocationIds(user)
    if (!userLocationIds.includes(block.location_id)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }

  // Capacity check — at-this-layer, not a constraint, so the
  // override path is just `allow_over_capacity: true`.
  const currentCount = block.shift_assignments?.[0]?.count ?? 0
  if (currentCount >= block.max_coaches && !body.allow_over_capacity) {
    return NextResponse.json(
      {
        success: false,
        error: `Block is at capacity (${currentCount}/${block.max_coaches}). Pass allow_over_capacity: true to override.`,
      },
      { status: 409 }
    )
  }

  // Time-off warning (advisory; mirrors legacy shifts POST).
  const { data: timeOff } = await db
    .from('time_off_requests')
    .select('type, start_date, end_date, profiles!profile_id(full_name)')
    .eq('profile_id', body.profile_id)
    .eq('status', 'approved')
    .lte('start_date', block.block_date)
    .gte('end_date', block.block_date)

  const warnings = (timeOff || []).map(
    t => `${t.profiles?.full_name} has approved ${t.type} from ${t.start_date} to ${t.end_date}`
  )

  const { data, error } = await db
    .from('shift_assignments')
    .insert({
      block_id: params.id,
      profile_id: body.profile_id,
      notes: body.notes || null,
      assigned_by: user.id,
    })
    .select(`
      id, block_id, profile_id, notes, status, assigned_at,
      profiles:profile_id(id, full_name, email, avatar_url, role)
    `)
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { success: false, error: 'This coach is already assigned to this block.' },
        { status: 409 }
      )
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json(
    { success: true, data, warnings: warnings.length > 0 ? warnings : undefined },
    { status: 201 }
  )
}
