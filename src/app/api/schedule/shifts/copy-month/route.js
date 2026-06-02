// POST /api/schedule/shifts/copy-month
//
// Mirrors copy-week but for an entire calendar month. The composer
// drives this from the monthly schedule view's "Copy Last Month"
// button — the most common case is "rinse and repeat last month's
// roster, then tweak".
//
// Body: { location_id, source_month_start, target_month_start }
//   - both must be the FIRST of a calendar month (YYYY-MM-01).
//   - the date range copied is source_month_start through the last
//     day of THAT month (28-31 days depending on month / leap year).
//
// Day-of-month mapping
// --------------------
// Each source shift maps to the same day-of-month in the target month.
// E.g. a shift on Jan 5 -> Feb 5; Jan 31 -> Feb 31 doesn't exist, so
// it's skipped (and reported back in the response as `skipped`).
//
// We deliberately don't try to be clever about February:
//   - Jan 29-31 -> Feb (28 or 29 days): skip
//   - Feb 28/29 -> March: maps cleanly
// Skipping is the safest default; the alternative (clamp to
// end-of-month) would silently bunch multiple source shifts onto
// Feb 28, which is rarely what an operator wants.
//
// Idempotency
// -----------
// Same upsert pattern as copy-week — the unique key
// (location_id, profile_id, shift_template_id, shift_date) means
// re-running over an already-copied month updates rather than
// duplicates. Manager re-runs after edits land cleanly.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate, MANAGER_ROLES } from '@/lib/schemas'
import { bulkUpsertShiftAssignments } from '@/lib/roster-write'
import { fetchSourceShiftRows } from '@/lib/roster-read'

export const runtime = 'nodejs'

// Same shape as copy-week — keeps the field naming convention
// consistent across the two endpoints.
const CopyMonthSchema = z.object({
  location_id: uuidLike,
  source_month_start: isoDate,
  target_month_start: isoDate,
})

/**
 * Days in the calendar month that contains the given ISO date.
 * Pure helper — exported for the unit test in copy-month.test.js.
 */
export function daysInMonth(isoDateStr) {
  const d = new Date(isoDateStr + 'T00:00:00')
  // Day 0 of month+1 = last day of month.
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
}

/**
 * Map a YYYY-MM-DD source date to the same day-of-month in the
 * target month. Returns null if the day-of-month doesn't exist in
 * the target (e.g. Jan 31 -> Feb).
 *
 * Pure helper — exported for unit tests.
 */
export function mapDayOfMonth(sourceIso, targetMonthStartIso) {
  const source = new Date(sourceIso + 'T00:00:00')
  const targetStart = new Date(targetMonthStartIso + 'T00:00:00')
  const day = source.getDate()
  const targetMonthDays = daysInMonth(targetMonthStartIso)
  if (day > targetMonthDays) return null
  const mapped = new Date(targetStart.getFullYear(), targetStart.getMonth(), day)
  // Format as YYYY-MM-DD without timezone shenanigans.
  const yyyy = mapped.getFullYear()
  const mm = String(mapped.getMonth() + 1).padStart(2, '0')
  const dd = String(mapped.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, CopyMonthSchema)
  if (!validation.ok) return validation.response
  const { location_id, source_month_start, target_month_start } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard

  // Validate inputs are first-of-month — clearer error than a silent
  // off-by-one if a manager passes a mid-month date.
  if (!/^(\d{4})-(\d{2})-01$/.test(source_month_start) || !/^(\d{4})-(\d{2})-01$/.test(target_month_start)) {
    return NextResponse.json(
      { success: false, error: 'source_month_start and target_month_start must be the first of a calendar month (YYYY-MM-01).' },
      { status: 400 },
    )
  }

  const db = createServerClient()

  // Compute the source range: 1st through last-day of source month.
  const sourceLastDay = daysInMonth(source_month_start)
  const sourceEnd = `${source_month_start.slice(0, 7)}-${String(sourceLastDay).padStart(2, '0')}`

  // Source rows from the Roster v2 model (blocks + assignments).
  const { rows: sourceRows, error: fetchError } = await fetchSourceShiftRows(db, {
    locationId: location_id,
    startDate: source_month_start,
    endDate: sourceEnd,
  })

  if (fetchError) return NextResponse.json({ success: false, error: fetchError.message }, { status: 400 })

  if (!sourceRows || sourceRows.length === 0) {
    return NextResponse.json({ success: false, error: 'No shifts found in the source month' }, { status: 404 })
  }

  // Map each source row's date to the target month, dropping ones
  // that fall on a day-of-month that doesn't exist in the target
  // (e.g. Jan 31 -> Feb).
  const newRows = []
  let skippedCount = 0
  for (const r of sourceRows) {
    const mappedDate = mapDayOfMonth(r.shiftDate, target_month_start)
    if (mappedDate === null) {
      skippedCount++
      continue
    }
    newRows.push({
      profileId: r.profileId,
      shiftTemplateId: r.shiftTemplateId,
      shiftDate: mappedDate,
      startTimeOverride: r.startTimeOverride,
      endTimeOverride: r.endTimeOverride,
      notes: r.notes,
      status: 'scheduled',
    })
  }

  if (newRows.length === 0) {
    return NextResponse.json({
      success: true,
      data: [],
      copied: 0,
      skipped: skippedCount,
      message: skippedCount > 0
        ? `Every source shift fell on a day-of-month that doesn't exist in the target (likely Feb).`
        : 'No shifts to copy.',
    })
  }

  // Find-or-create blocks + upsert assignments (new model). New blocks
  // carry no roster_id → copied shifts read unpublished until publish.
  const { count, error } = await bulkUpsertShiftAssignments(db, {
    locationId: location_id,
    actorId: user.id,
    rows: newRows,
  })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({
    success: true,
    copied: count,
    skipped: skippedCount,
  }, { status: 201 })
}
