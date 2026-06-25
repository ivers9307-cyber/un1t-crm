import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate , MANAGER_ROLES} from '@/lib/schemas'
import { bulkUpsertShiftAssignments } from '@/lib/roster-write'
import { fetchSourceShiftRows } from '@/lib/roster-read'
import { formatDate } from '@/lib/roster'

const CopyWeekSchema = z.object({
  location_id: uuidLike,
  source_start: isoDate,
  target_start: isoDate,
})

// Date math extracted as pure helpers so the BST-sensitive bits are
// unit-testable without mocking Supabase (mirrors copy-month's exported
// daysInMonth/mapDayOfMonth). They build local-midnight Dates and format
// via roster.formatDate (LOCAL Y/M/D) — never toISOString(), which would
// slip the date back a day under BST.

/**
 * Last day of the source week: source_start (a Monday) + 6 days.
 * Returns YYYY-MM-DD.
 */
export function sourceWeekEnd(sourceStart) {
  const end = new Date(sourceStart + 'T00:00:00')
  end.setDate(end.getDate() + 6)
  return formatDate(end)
}

/**
 * Whole-day offset between two YYYY-MM-DD dates (target - source).
 * Positive when target is later. Built on local-midnight Dates so the
 * subtraction can't be skewed by a DST boundary between them.
 */
export function weekDayOffset(sourceStart, targetStart) {
  const s = new Date(sourceStart + 'T00:00:00')
  const t = new Date(targetStart + 'T00:00:00')
  return Math.round((t - s) / (1000 * 60 * 60 * 24))
}

/**
 * Shift a YYYY-MM-DD date by `dayOffset` whole days, returning
 * YYYY-MM-DD. Local-component arithmetic keeps Sunday in range and
 * lands the copy on the intended calendar day under BST.
 */
export function redateShiftDate(shiftDate, dayOffset) {
  const d = new Date(shiftDate + 'T00:00:00')
  d.setDate(d.getDate() + dayOffset)
  return formatDate(d)
}

// POST /api/schedule/shifts/copy-week
// Copy all shifts from one week to another
// Body: { location_id, source_start (Mon), target_start (Mon) }
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, CopyWeekSchema)
  if (!validation.ok) return validation.response
  const { location_id, source_start, target_start } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard

  const db = createServerClient()

  // Source week end (source_start + 6 days). See sourceWeekEnd note:
  // local-component formatting, never toISOString() (BST off-by-one).
  const sourceEnd = sourceWeekEnd(source_start)

  // Fetch source shifts from the Roster v2 model (blocks + assignments).
  const { rows: sourceRows, error: fetchError } = await fetchSourceShiftRows(db, {
    locationId: location_id,
    startDate: source_start,
    endDate: sourceEnd,
  })

  if (fetchError) return NextResponse.json({ success: false, error: fetchError.message }, { status: 400 })

  if (!sourceRows || sourceRows.length === 0) {
    return NextResponse.json({ success: false, error: 'No shifts found in the source week' }, { status: 404 })
  }

  // Calculate day offset between source and target.
  const dayOffset = weekDayOffset(source_start, target_start)

  // Re-date each source row into the target week.
  const newRows = sourceRows.map((r) => ({
    profileId: r.profileId,
    shiftTemplateId: r.shiftTemplateId,
    shiftDate: redateShiftDate(r.shiftDate, dayOffset),
    startTimeOverride: r.startTimeOverride,
    endTimeOverride: r.endTimeOverride,
    notes: r.notes,
    status: 'scheduled',
  }))

  // Find-or-create blocks + upsert assignments (new model). Newly-created
  // blocks carry no roster_id, so the copied shifts read as unpublished
  // until the manager publishes — same as the legacy published:false.
  const { count, error } = await bulkUpsertShiftAssignments(db, {
    locationId: location_id,
    actorId: user.id,
    rows: newRows,
  })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, copied: count }, { status: 201 })
}
