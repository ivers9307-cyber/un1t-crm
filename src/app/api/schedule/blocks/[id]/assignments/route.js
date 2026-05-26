// /api/schedule/blocks/[id]/assignments — POST
//
// Assigns one or more coaches to a shift_block. The mig 068 trigger
// mirrors each new assignment row into the legacy public.shifts table
// so mobile + reports keep seeing the data.
//
// Two modes, picked by which field the client sends:
//   { profile_id }           — legacy single-coach mode. Response is
//                              { success, data, warnings? } and 4xx on
//                              already-assigned / at-capacity, matching
//                              the original contract used by existing
//                              callers.
//   { profile_ids: [uuid] }  — SCHEDULE-MULTI-COACH.1. Iterates the list,
//                              capacity-checks per-coach (running count
//                              advances as we go), inserts each. Returns
//                              { success, assigned, skipped, warnings? }
//                              with per-coach outcomes — the operator
//                              sees exactly who was added and who wasn't.
//
// Capacity (block.max_coaches) is enforced at this layer, not via CHECK,
// so an admin override ("we really do need a 16th coach today") stays
// possible by passing { allow_over_capacity: true }.
//
// Time-off conflicts are surfaced as warnings (advisory; mirrors the
// legacy /api/schedule/shifts POST), not a hard block.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'

const AssignSchema = z.object({
  profile_id: uuidLike.optional(),
  profile_ids: z.array(uuidLike).min(1).max(50).optional(),
  notes: z.string().max(2000).nullable().optional(),
  allow_over_capacity: z.boolean().optional(),
}).refine(
  (d) => Boolean(d.profile_id) !== (Array.isArray(d.profile_ids) && d.profile_ids.length > 0),
  { message: 'Provide exactly one of profile_id or profile_ids' },
)

const ASSIGNMENT_SELECT = `
  id, block_id, profile_id, notes, status, assigned_at,
  profiles:profile_id(id, full_name, email, avatar_url, role)
`

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, AssignSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const isLegacySingle = Boolean(body.profile_id)

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

  // Normalise to an array; dedupe so a doubled-up client send doesn't
  // produce ambiguous outcomes.
  const requestedIds = isLegacySingle
    ? [body.profile_id]
    : Array.from(new Set(body.profile_ids))

  // Who's already on this block? Skip them silently — same posture
  // as bulk-assign. Pulled once up-front to avoid an N+1.
  const { data: existingAssigns } = await db
    .from('shift_assignments')
    .select('profile_id')
    .eq('block_id', params.id)
  const alreadyAssignedIds = new Set((existingAssigns || []).map((a) => a.profile_id))

  let runningCount = block.shift_assignments?.[0]?.count ?? 0

  const assigned = []
  const skipped = []
  const warnings = []

  for (const profileId of requestedIds) {
    if (alreadyAssignedIds.has(profileId)) {
      skipped.push({ profile_id: profileId, reason: 'already_assigned' })
      continue
    }
    if (runningCount >= block.max_coaches && !body.allow_over_capacity) {
      skipped.push({ profile_id: profileId, reason: 'at_capacity' })
      continue
    }

    // Per-coach time-off advisory. Mirrors the legacy shifts POST.
    const { data: timeOff } = await db
      .from('time_off_requests')
      .select('type, start_date, end_date, profiles!profile_id(full_name)')
      .eq('profile_id', profileId)
      .eq('status', 'approved')
      .lte('start_date', block.block_date)
      .gte('end_date', block.block_date)
    for (const t of timeOff || []) {
      warnings.push(`${t.profiles?.full_name} has approved ${t.type} from ${t.start_date} to ${t.end_date}`)
    }

    const { data: ins, error: insErr } = await db
      .from('shift_assignments')
      .insert({
        block_id: params.id,
        profile_id: profileId,
        notes: body.notes || null,
        assigned_by: user.id,
      })
      .select(ASSIGNMENT_SELECT)
      .single()

    if (insErr) {
      // 23505 = unique-constraint race: another writer added this
      // coach between our pre-check and our insert. Treat as a
      // silent already_assigned, matching the pre-check branch.
      if (insErr.code === '23505') {
        skipped.push({ profile_id: profileId, reason: 'already_assigned' })
      } else {
        skipped.push({ profile_id: profileId, reason: insErr.message || 'insert_failed' })
      }
      continue
    }

    assigned.push(ins)
    alreadyAssignedIds.add(profileId)
    runningCount += 1
  }

  // Legacy single-coach response shape — preserve byte-for-byte so
  // existing callers (handleAssignCoach historical, any mobile call)
  // don't notice the route changed.
  if (isLegacySingle) {
    if (assigned.length === 1) {
      return NextResponse.json(
        { success: true, data: assigned[0], warnings: warnings.length > 0 ? warnings : undefined },
        { status: 201 },
      )
    }
    const skip = skipped[0]
    if (skip?.reason === 'already_assigned') {
      return NextResponse.json(
        { success: false, error: 'This coach is already assigned to this block.' },
        { status: 409 },
      )
    }
    if (skip?.reason === 'at_capacity') {
      const currentCount = block.shift_assignments?.[0]?.count ?? 0
      return NextResponse.json(
        {
          success: false,
          error: `Block is at capacity (${currentCount}/${block.max_coaches}). Pass allow_over_capacity: true to override.`,
        },
        { status: 409 },
      )
    }
    return NextResponse.json(
      { success: false, error: skip?.reason || 'Failed to assign coach' },
      { status: 400 },
    )
  }

  // Multi-coach response — per-coach outcomes. Always 201 with
  // success: true; the operator inspects assigned/skipped to see
  // exactly what happened.
  return NextResponse.json(
    {
      success: true,
      assigned,
      skipped,
      warnings: warnings.length > 0 ? warnings : undefined,
    },
    { status: 201 },
  )
}
