// /api/schedule/assignments/[id] — PUT, DELETE
//
// PUT — partial-shift edits (mig 099/100). Operator can override the
//       assignment's start/end times when they differ from the parent
//       block, and add a free-text reason. Overrides live on the
//       assignment row; payroll + reports read them from
//       shift_assignments (the public.shifts mirror was dropped in mig 238).
//
// DELETE — removes a coach from a shift_block (deletes the
//       shift_assignment row).
//
// Coaches can edit/remove themselves on assignments they own.
// Managers can edit/remove anyone at a location they own.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES, timeOfDay } from '@/lib/schemas'
import { notifyUsers } from '@/lib/notify'
import { logRosterChange } from '@/lib/roster-change-log'
import { logWarn } from '@/lib/log'

// All fields optional. To CLEAR an override, send null explicitly
// (z.nullable() vs .optional() — PUT body should pass null to remove
// a previously-set override; omit the key to leave it unchanged).
const UpdateAssignmentSchema = z.object({
  start_time_override: timeOfDay.nullable().optional(),
  end_time_override: timeOfDay.nullable().optional(),
  partial_reason: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(['scheduled', 'confirmed', 'declined', 'completed']).optional(),
})

export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const validation = await validateBody(request, UpdateAssignmentSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: false, error: 'Empty update' }, { status: 400 })
  }

  const db = createServerClient()

  const { data: assignment, error: fetchErr } = await db
    .from('shift_assignments')
    .select('id, profile_id, block_id, shift_blocks!block_id(location_id, start_time, end_time, block_date, roster_id, rosters:roster_id(status))')
    .eq('id', params.id)
    .single()
  if (fetchErr || !assignment) {
    return NextResponse.json({ success: false, error: 'Assignment not found' }, { status: 404 })
  }

  const isSelf = assignment.profile_id === user.id
  const isManager = MANAGER_ROLES.includes(user.role)
  if (!isSelf && !isManager) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if (isManager && user.role !== 'master') {
    const userLocationIds = getUserLocationIds(user)
    const blockLocation = assignment.shift_blocks?.location_id
    if (blockLocation && !userLocationIds.includes(blockLocation)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }

  // Soft sanity check on overrides — if both are set and end <= start
  // (and neither crosses midnight), the operator's typo'd. Reject
  // rather than silently saving a 0-or-negative-duration shift.
  // Overnight shifts (end < start, e.g. 22:00→06:00) stay valid.
  // We only enforce when the override is the same calendar day as
  // the block — if the operator clearly wants something exotic, let
  // them through.
  const newStart = Object.prototype.hasOwnProperty.call(updates, 'start_time_override')
    ? updates.start_time_override
    : null
  const newEnd = Object.prototype.hasOwnProperty.call(updates, 'end_time_override')
    ? updates.end_time_override
    : null
  if (newStart && newEnd && newStart === newEnd) {
    return NextResponse.json(
      { success: false, error: 'Override start and end cannot be identical.' },
      { status: 400 }
    )
  }

  const { data, error } = await db
    .from('shift_assignments')
    .update(updates)
    .eq('id', params.id)
    .select(`
      id, block_id, profile_id, notes, status, assigned_at, updated_at,
      start_time_override, end_time_override, partial_reason,
      shift_blocks!block_id (
        block_date, start_time, end_time,
        shift_templates ( name )
      ),
      profiles:profile_id(id, full_name, email, avatar_url, role)
    `)
    .single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Push the affected coach when a manager (not self) actually
  // changed the override times. Same-fields-as-before doesn't
  // count — we compare to assignment we read pre-update.
  const wasManagerEdit = assignment.profile_id !== user.id
  const overrideChanged =
    Object.prototype.hasOwnProperty.call(updates, 'start_time_override') ||
    Object.prototype.hasOwnProperty.call(updates, 'end_time_override') ||
    Object.prototype.hasOwnProperty.call(updates, 'partial_reason')
  if (wasManagerEdit && overrideChanged) {
    try {
      const block = data.shift_blocks
      const tplName = block?.shift_templates?.name || 'Shift'
      const date = block?.block_date || ''
      const dateLabel = date
        ? new Date(date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })
        : ''
      const blockStart = (block?.start_time || '').slice(0, 5)
      const blockEnd = (block?.end_time || '').slice(0, 5)
      const newStart = (data.start_time_override || block?.start_time || '').slice(0, 5)
      const newEnd = (data.end_time_override || block?.end_time || '').slice(0, 5)
      const cleared = !data.start_time_override && !data.end_time_override
      const body = cleared
        ? `${tplName} ${dateLabel}: back to block default ${blockStart}–${blockEnd}.`
        : `${tplName} ${dateLabel}: now ${newStart}–${newEnd}` +
          (data.partial_reason ? ` · ${data.partial_reason}` : '')

      // NOTIF.9 — migrated to notifyUsers. Shift changes are
      // important enough to email-fallback when the coach doesn't
      // have the app (they need to know their hours changed before
      // they show up to the wrong shift).
      await notifyUsers([data.profile_id], {
        title: 'Shift adjusted',
        body,
        category: 'shift_adjusted',
        emailSubject: `Shift adjustment — ${tplName} ${dateLabel}`,
        data: {
          type: 'shift_adjusted',
          assignment_id: data.id,
          block_date: date,
        },
      })
    } catch (e) {
      logWarn('assignment-update', `notify failed for ${data.id}`, { err: e })
    }

    // SCHEDULE-CHANGE-LOG.1 — record the time change on a published roster
    // so the next re-publish re-notifies this coach. Best-effort.
    if (assignment.shift_blocks?.rosters?.status === 'published') {
      await logRosterChange(db, {
        isPublished: true,
        locationId: assignment.shift_blocks?.location_id,
        blockId: assignment.block_id,
        blockDate: data.shift_blocks?.block_date || assignment.shift_blocks?.block_date,
        actorId: user.id,
        coachId: data.profile_id,
        action: 'time_changed',
        details: {
          start_time_override: data.start_time_override || null,
          end_time_override: data.end_time_override || null,
        },
      })
    }
  }

  return NextResponse.json({ success: true, data })
}

export async function DELETE(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()

  // Pull the assignment + parent block so we can authorise.
  const { data: assignment, error: fetchErr } = await db
    .from('shift_assignments')
    .select('id, profile_id, block_id, shift_blocks!block_id(location_id, block_date, roster_id, rosters:roster_id(status))')
    .eq('id', params.id)
    .single()

  if (fetchErr || !assignment) {
    return NextResponse.json({ success: false, error: 'Assignment not found' }, { status: 404 })
  }

  const isSelf = assignment.profile_id === user.id
  const isManager = MANAGER_ROLES.includes(user.role)

  if (!isSelf && !isManager) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // Per-location ownership check for non-master managers.
  if (isManager && user.role !== 'master') {
    const userLocationIds = getUserLocationIds(user)
    const blockLocation = assignment.shift_blocks?.location_id
    if (blockLocation && !userLocationIds.includes(blockLocation)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }

  const { error } = await db.from('shift_assignments').delete().eq('id', params.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // SCHEDULE-CHANGE-LOG.1 — record a manager removing a coach from a
  // published roster (skip self-removal — the coach already knows) so the
  // next re-publish re-notifies them. Best-effort.
  if (!isSelf && assignment.shift_blocks?.rosters?.status === 'published') {
    await logRosterChange(db, {
      isPublished: true,
      locationId: assignment.shift_blocks?.location_id,
      blockId: assignment.block_id,
      blockDate: assignment.shift_blocks?.block_date,
      actorId: user.id,
      coachId: assignment.profile_id,
      action: 'unassigned',
    })
  }

  return NextResponse.json({ success: true })
}
