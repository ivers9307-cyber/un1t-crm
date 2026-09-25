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
import { getCurrentUser, assertLocationAccess, getUserLocationIds, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate, timeOfDay, MANAGER_ROLES } from '@/lib/schemas'
import { findPublishedRosterFor } from '@/lib/roster'
import { logWarn } from '@/lib/log'
import { adminMinimumRefusal } from '@/lib/shift-template-kind'

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

  const startDate = searchParams.get('start_date')
  const endDate = searchParams.get('end_date')
  const db = createServerClient()

  let query = db
    .from('shift_blocks')
    .select(`
      *,
      rosters:roster_id ( status ),
      shift_templates(id, name, color, role_label, start_time, end_time, days_of_week, max_coaches, kind),
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
  //
  // COACHSCOPE.1 — "manager" is judged per block against the caller's role at
  // THAT block's location, not `user.role` (the ACTIVE location's role): a head
  // coach at one studio who is plain staff at another passed the old check
  // while reading the other studio's drafts via ?location_id=.
  const shaped = (data || []).flatMap((b) => {
    if (hasRoleAtLocation(user, b.location_id, MANAGER_ROLES)) return [b]
    return b.rosters?.status === 'published' ? [slimBlockForCoach(b)] : []
  })
  return NextResponse.json({ success: true, data: shaped })
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
          // SHIFTTYPE.1 — class | admin. Not a capacity fact: a coach's admin
          // shift is drawn in the admin tone too.
          kind: tpl.kind,
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
        // COACHSCOPE.1 — who is on it, not how to email them.
        profiles: a.profiles
          ? { id: a.profiles.id, full_name: a.profiles.full_name, avatar_url: a.profiles.avatar_url, role: a.profiles.role }
          : a.profiles,
      })),
  }
}

// POST /api/schedule/blocks — manual block creation. Most blocks
// come from the auto-generator when a template is saved; this
// endpoint exists for one-off "I need an extra slot on this Saturday"
// cases.
//
// SCHEDROLES.1 — the caller must be a manager AT body.location_id, not at
// their active studio (`user.role`). Membership first (its 403 names the
// location problem), then the role there.
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, BlockCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, body.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  // If start/end/max/min weren't supplied, snapshot from the
  // template. SHIFTMIN.1 — min_coaches uses `??` (not `||`) on the
  // body value because `0` is a legitimate explicit choice and
  // shouldn't fall through to the template default.
  //
  // SCHEDROLES.1 — the template is ALWAYS read, scoped to body.location_id,
  // even when every snapshot field was supplied: a block must never hang off
  // another studio's template. A template elsewhere reads as not found (404).
  let start = body.start_time
  let end = body.end_time
  let max = body.max_coaches
  let min = body.min_coaches
  const { data: tpl, error: tplErr } = await db
    .from('shift_templates')
    .select('start_time, end_time, max_coaches, min_coaches, kind')
    .eq('id', body.template_id)
    .eq('location_id', body.location_id)
    .maybeSingle()
  if (tplErr) {
    return NextResponse.json({ success: false, error: tplErr.message }, { status: 500 })
  }
  if (!tpl) {
    return NextResponse.json(
      { success: false, error: 'Template not found' },
      { status: 404 }
    )
  }
  // SHIFTTYPE.1 — an admin shift has no minimum staffing. An explicit
  // minimum is a contradiction the caller should hear about (400, the same
  // answer as the template routes); an omitted one is 0.
  const refusal = adminMinimumRefusal(tpl.kind, body.min_coaches)
  if (refusal) return NextResponse.json(refusal.body, { status: refusal.status })
  start = start || tpl.start_time
  end = end || tpl.end_time
  max = max || tpl.max_coaches || 15
  min = tpl.kind === 'admin' ? 0 : (min ?? (tpl.min_coaches ?? 1))

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
      shift_templates(id, name, color, role_label, start_time, end_time, days_of_week, max_coaches, kind),
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

  // SLOTREMOVAL.1 — adding a slot back by hand is the undo for "Delete this
  // slot": clear its removal row so the nightly generator and roster copies
  // treat it as a normal slot again. The block exists either way; if this
  // fails, the stale row only matters once the block is deleted again, so it
  // is a warning, not a failure.
  const { error: restoreErr } = await db
    .from('shift_block_removals')
    .delete()
    .eq('location_id', body.location_id)
    .eq('template_id', body.template_id)
    .eq('block_date', body.block_date)
  if (restoreErr) {
    logWarn('schedule-blocks', 'clearing slot removal failed', {
      locationId: body.location_id, templateId: body.template_id, blockDate: body.block_date, err: restoreErr,
    })
    return NextResponse.json({
      success: true,
      data,
      warning: 'Slot added, but its earlier removal could not be cleared.',
    }, { status: 201 })
  }

  return NextResponse.json({ success: true, data }, { status: 201 })
}
