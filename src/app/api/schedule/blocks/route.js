// /api/schedule/blocks
//
// Roster v2 phase 2 — block-shaped read endpoint for the schedule
// calendar. Returns each shift_block with its template + nested
// assignments (each joined to the assigned profile). Empty blocks
// come through as rows with assignments: [].
//
// Replaces the calendar's previous use of /api/schedule/shifts.
// The legacy /shifts GET endpoint stays in place because mobile + the
// report generator still consume that shape — but it now reads
// shift_blocks + shift_assignments and normalises to the old shape
// (the public.shifts mirror + its mig 068 trigger were dropped in mig 238).
//
// POST is for manual block creation (rare — most blocks are
// auto-generated when a template's days_of_week is saved).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate, timeOfDay, MANAGER_ROLES } from '@/lib/schemas'
import { findPublishedRosterFor } from '@/lib/roster'

const BlockCreateSchema = z.object({
  location_id: uuidLike,
  template_id: uuidLike,
  block_date: isoDate,
  start_time: timeOfDay.optional(),
  end_time: timeOfDay.optional(),
  max_coaches: z.number().int().min(1).max(50).optional(),
  min_coaches: z.number().int().min(0).max(50).optional(),
  notes: z.string().max(2000).nullable().optional(),
})

// GET /api/schedule/blocks?location_id=...&start_date=...&end_date=...
export async function GET(request) {
  const user = await getCurrentUser()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const isManager = MANAGER_ROLES.includes(user.role)

  const startDate = searchParams.get('start_date')
  const endDate = searchParams.get('end_date')
  const db = createServerClient()

  let query = db
    .from('shift_blocks')
    .select(`
      *,
      rosters:roster_id ( status ),
      shift_templates(id, name, color, role_label, start_time, end_time, days_of_week, max_coaches),
      shift_assignments(
        id,
        profile_id,
        notes,
        status,
        assigned_at,
        start_time_override,
        end_time_override,
        partial_reason,
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

  // ROSTER-FIX.2 — the calendar is a coach surface too (ScheduleRosterView
  // renders ScheduleCalendar for every role), so this feed cannot be
  // manager-only. It is instead narrowed twice for a non-manager caller:
  //
  //   D1 (Richard's call) — a coach never sees a DRAFT shift. A roster is
  //   a working document until it is published; showing an unpublished
  //   block invites a coach to plan around a shift that may still move or
  //   disappear. Hence the embedded `rosters.status` and the published-only
  //   filter (a block with no roster attached is not published either).
  //
  //   Capacity is a MANAGER fact — min_coaches/max_coaches say how many
  //   bodies a shift is budgeted for, and block notes / assignment notes /
  //   partial_reason are the manager's working notes about people. None of
  //   that is a coach's business; a coach needs the time, the shift name
  //   and who else is on it. Cancelled assignments are dropped for the same
  //   reason — a coach reads the roster as it stands, not its history.
  //
  // Managers keep the full ManageMode shape, drafts included.
  if (!isManager) {
    const published = (data || []).filter((b) => b.rosters?.status === 'published')
    return NextResponse.json({ success: true, data: published.map(slimBlockForCoach) })
  }

  return NextResponse.json({ success: true, data })
}

// ROSTER-FIX.2 — the coach-facing projection of a block row. Allow-list,
// not a delete-list: a column added to shift_blocks later is invisible to
// coaches until someone puts it here on purpose.
function slimBlockForCoach(block) {
  const tpl = block.shift_templates
  return {
    id: block.id,
    location_id: block.location_id,
    template_id: block.template_id,
    block_date: block.block_date,
    start_time: block.start_time,
    end_time: block.end_time,
    roster_id: block.roster_id,
    rosters: block.rosters,
    // The template embed carries max_coaches as well — same capacity fact,
    // one join further out. Dropped here so the slim shape has no back door.
    shift_templates: tpl
      ? {
          id: tpl.id,
          name: tpl.name,
          color: tpl.color,
          role_label: tpl.role_label,
          start_time: tpl.start_time,
          end_time: tpl.end_time,
          days_of_week: tpl.days_of_week,
        }
      : tpl,
    shift_assignments: (block.shift_assignments || [])
      .filter((a) => a.status !== 'cancelled')
      .map((a) => ({
        id: a.id,
        profile_id: a.profile_id,
        status: a.status,
        assigned_at: a.assigned_at,
        start_time_override: a.start_time_override,
        end_time_override: a.end_time_override,
        profiles: a.profiles,
      })),
  }
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

  // If start/end/max/min weren't supplied, snapshot from the
  // template. SHIFTMIN.1 — min_coaches uses `??` (not `||`) on the
  // body value because `0` is a legitimate explicit choice and
  // shouldn't fall through to the template default.
  let start = body.start_time
  let end = body.end_time
  let max = body.max_coaches
  let min = body.min_coaches
  if (!start || !end || !max || min === undefined) {
    const { data: tpl, error: tplErr } = await db
      .from('shift_templates')
      .select('start_time, end_time, max_coaches, min_coaches')
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
    min = min ?? (tpl.min_coaches ?? 1)
  }

  // ROSTER-FIX.4 — if this date already sits inside a PUBLISHED period, the
  // new block joins that roster. Publishing tags the blocks that exist at
  // that moment; a block added afterwards stayed roster_id NULL, which every
  // reader treats as unpublished — so the extra slot a manager just created
  // for a published week was invisible to every coach.
  const rosterId = await findPublishedRosterFor(db, body.location_id, body.block_date)

  const { data, error } = await db
    .from('shift_blocks')
    .insert({
      location_id: body.location_id,
      template_id: body.template_id,
      block_date: body.block_date,
      start_time: start,
      end_time: end,
      max_coaches: max,
      min_coaches: min,
      roster_id: rosterId,
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
