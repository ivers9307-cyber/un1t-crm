// POST /api/schedule/shifts/copy-month
//
// Mirrors copy-week but for an entire calendar month. The composer
// drives this from the monthly schedule view's "Copy Last Month"
// button — the most common case is "rinse and repeat last month's
// roster, then tweak".
//
// Body: { location_id, source_month_start, target_month_start, mode? }
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
// COPYMODES.1 — that day-of-month mapping is the EXACT mode's. In TEMPLATE
// mode a coach belongs to a template slot (template + weekday), so the Nth
// weekday maps to the Nth weekday instead (first Monday -> first Monday; a
// 5th Monday the target lacks is skipped). Day-of-month would move a Monday
// slot's coach onto a Thursday, where that template mostly doesn't run.
//
// Idempotency (COPYFIX.1)
// -----------------------
// Same upsert pattern as copy-week — the unique key
// (block_id, profile_id), upserted with ON CONFLICT DO NOTHING. A
// re-run over an already-copied month adds only the coaches still
// missing from the target; a coach already assigned there is left
// exactly as they were — their override, notes, status and
// assigned_by are never touched. `copied` in the response counts
// only the rows actually inserted, so a full re-run reports 0.

import { NextResponse, after } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate, MANAGER_ROLES } from '@/lib/schemas'
import { bulkUpsertShiftAssignments } from '@/lib/roster-write'
import { fetchSourceBlocks, buildCopyPlan, mapNthWeekdayOfMonth, COPY_MODES } from '@/lib/roster-copy'
import { readAssignmentKeysInRange, logAndNotifyCopiedShifts } from '@/lib/roster-change-notify'

export const runtime = 'nodejs'

// Same shape as copy-week — keeps the field naming convention
// consistent across the two endpoints.
const CopyMonthSchema = z.object({
  location_id: uuidLike,
  source_month_start: isoDate,
  target_month_start: isoDate,
  // COPYMODES.1 — see copy-week. Missing = 'exact', today's behaviour.
  mode: z.enum(COPY_MODES).default('exact'),
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
  const { location_id, source_month_start, target_month_start, mode } = validation.data

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

  // Source blocks (with template + assignments) from the Roster v2 model.
  // Paged, so a busy month is never cut at the 1,000-row select cap.
  const { blocks: sourceBlocks, error: fetchError } = await fetchSourceBlocks(db, {
    locationId: location_id,
    startDate: source_month_start,
    endDate: sourceEnd,
  })

  if (fetchError) return NextResponse.json({ success: false, error: fetchError.message }, { status: 400 })

  // Map each source block's date into the target month; a day with no
  // counterpart (e.g. Jan 31 -> Feb, or a 5th weekday in template mode) is
  // dropped and its coaches are reported back as `skipped`.
  const plan = buildCopyPlan(sourceBlocks, {
    mode,
    mapDate: mode === 'template'
      ? (d) => mapNthWeekdayOfMonth(d, target_month_start)
      : (d) => mapDayOfMonth(d, target_month_start),
  })

  if (plan.sourceAssignments === 0) {
    return NextResponse.json({ success: false, error: 'No shifts found in the source month' }, { status: 404 })
  }

  if (plan.rows.length === 0 && plan.blocks.length === 0) {
    return NextResponse.json({
      success: true,
      data: [],
      copied: 0,
      skipped: plan.skipped,
      mode,
      message: mode === 'template'
        ? 'Every source shift was on a template that is inactive, no longer runs that weekday, or has no matching weekday in the target month.'
        : `Every source shift fell on a day-of-month that doesn't exist in the target (likely Feb).`,
    })
  }

  // NOTIFY.1 — see copy-week.
  const targetEnd = `${target_month_start.slice(0, 7)}-${String(daysInMonth(target_month_start)).padStart(2, '0')}`
  const before = await readAssignmentKeysInRange(db, { locationId: location_id, startDate: target_month_start, endDate: targetEnd })

  // Find-or-create blocks + insert assignments (new model). A block created
  // inside an already-published period joins that roster (ROSTER-FIX.4).
  const { count, error } = await bulkUpsertShiftAssignments(db, {
    locationId: location_id,
    actorId: user.id,
    rows: plan.rows,
    blocks: plan.blocks,
  })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // NOTIFY.1 review — see copy-week: the AFTER snapshot is read synchronously
  // here, right after the upsert commits, so it can't race a second copy onto
  // the same period. Only the log+notify step is deferred via `after`.
  const afterSnap = await readAssignmentKeysInRange(db, { locationId: location_id, startDate: target_month_start, endDate: targetEnd })

  after(() => logAndNotifyCopiedShifts(db, {
    locationId: location_id,
    actorId: user.id,
    startDate: target_month_start,
    endDate: targetEnd,
    before,
    after: afterSnap,
    via: 'copy_month',
  }))

  return NextResponse.json({
    success: true,
    copied: count,
    skipped: plan.skipped,
    mode,
  }, { status: 201 })
}
