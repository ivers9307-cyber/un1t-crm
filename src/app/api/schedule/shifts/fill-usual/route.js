// USUALCOACH.1 — POST /api/schedule/shifts/fill-usual
//
// Put each shift template's usual coaches (mig 869) onto a week's shifts at
// one studio. The empty-week card's "Fill usual coaches" button calls it; the
// nightly horizon does the same for the shifts it creates.
//
// Body: { location_id, week_start (a Monday, YYYY-MM-DD) }
// Answer: { success, assigned, skipped, counts, skipped_coaches }
//   skipped_coaches  [{ block_id, profile_id, reason }] — a coach the fill left
//                    off a shift, and why (the toast says the counts; the
//                    profile ids are for the screen, which already holds names)
//
// Rules (src/lib/shift-usual-coaches.js): never a shift that already has a
// coach, never a shift on a published roster, never a past shift (the
// studio's today, TZ.8a), never over approved leave, a cannot-work rule or an
// overlapping shift, never past a shift's maximum. Same permission as editing
// templates: a manager AT location_id.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { realIsoDate, MANAGER_ROLES } from '@/lib/schemas'
import { getLocationZone, todayStrIn, addDaysISO } from '@/lib/location-time'
import { readBlocksForFill, fillUsualCoaches } from '@/lib/shift-usual-coaches'
import { logError, logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const maxDuration = 60

const FillUsualSchema = z.object({
  location_id: uuidLike,
  week_start: realIsoDate,
})

export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const validation = await validateBody(request, FillUsualSchema)
  if (!validation.ok) return validation.response
  const { location_id: locationId, week_start: weekStart } = validation.data

  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  // A past shift is never filled: "today" is the studio's day.
  let today
  try {
    today = todayStrIn(await getLocationZone(db, locationId))
  } catch (e) {
    logError('schedule-fill-usual', 'studio timezone unreadable; nothing filled', { locationId, err: e?.message })
    return NextResponse.json({ success: false, error: 'Could not read the studio clock. Nothing was changed; try again.' }, { status: 503 })
  }
  const weekEnd = addDaysISO(weekStart, 6)
  const startDate = weekStart > today ? weekStart : today
  if (startDate > weekEnd) {
    return NextResponse.json({ success: false, error: 'That week is over, so there is nothing to fill.' }, { status: 400 })
  }

  const { blocks, error } = await readBlocksForFill(db, { locationId, startDate, endDate: weekEnd })
  if (error) {
    logError('schedule-fill-usual', 'shift read failed; nothing filled', { locationId, code: error.code || null, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not read the week\'s shifts.' }, { status: 500 })
  }
  // Defence in depth: the read is scoped by location_id; re-check every row.
  const here = blocks.filter((b) => b.location_id === locationId)

  const fill = await fillUsualCoaches(db, here, { actorId: user.id })
  if (fill.skipped.length > 0) {
    // Counts only: no names in logs.
    logInfo('schedule-fill-usual', 'usual coaches skipped', { locationId, weekStart, counts: fill.counts })
  }

  return NextResponse.json({
    success: true,
    assigned: fill.assigned.length,
    skipped: fill.skipped.length,
    counts: fill.counts,
    skipped_coaches: fill.skipped.filter((s) => s.profile_id),
  })
})
