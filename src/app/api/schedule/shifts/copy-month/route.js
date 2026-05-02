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

  const { data: sourceShifts, error: fetchError } = await db.from('shifts')
    .select('*')
    .eq('location_id', location_id)
    .gte('shift_date', source_month_start)
    .lte('shift_date', sourceEnd)

  if (fetchError) return NextResponse.json({ success: false, error: fetchError.message }, { status: 400 })

  if (!sourceShifts || sourceShifts.length === 0) {
    return NextResponse.json({ success: false, error: 'No shifts found in the source month' }, { status: 404 })
  }

  // Map each source shift's date to the target month, dropping ones
  // that fall on a day-of-month that doesn't exist in the target
  // (e.g. Jan 31 -> Feb).
  const newShifts = []
  let skippedCount = 0
  for (const s of sourceShifts) {
    const mappedDate = mapDayOfMonth(s.shift_date, target_month_start)
    if (mappedDate === null) {
      skippedCount++
      continue
    }
    newShifts.push({
      location_id: s.location_id,
      profile_id: s.profile_id,
      shift_template_id: s.shift_template_id,
      shift_date: mappedDate,
      start_time_override: s.start_time_override,
      end_time_override: s.end_time_override,
      role_label: s.role_label,
      notes: s.notes,
      status: 'scheduled',
      published: false,
      created_by: user.id,
    })
  }

  if (newShifts.length === 0) {
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

  const { data, error } = await db.from('shifts')
    .upsert(newShifts, { onConflict: 'location_id,profile_id,shift_template_id,shift_date', ignoreDuplicates: false })
    .select('*, shift_templates(*), profiles!profile_id(id, full_name, email, avatar_url, role)')

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({
    success: true,
    data,
    copied: newShifts.length,
    skipped: skippedCount,
  }, { status: 201 })
}
