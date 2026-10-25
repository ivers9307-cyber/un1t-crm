// src/app/api/schedule/change-log/route.js
// CHANGELOG.1 — GET /api/schedule/change-log
//
// Edits made to ALREADY-PUBLISHED rosters at one studio, for shifts dated in
// [from, to]: who changed what, for which coach, and whether the coach has
// been told (notified_at). Drives the "Changes since publish" drawer behind
// the schedule's Published chip. roster_change_log (mig 236) had writers and a
// re-notify reader, and no reader for a person.
//
// Gate: identical to the sibling GET /api/schedule/week-cost. MANAGER_ROLES,
// then assertLocationAccess on the caller-supplied location_id (a query-param
// route, so a foreign studio is a 403; the 404 rule is for ids in the path),
// then the role AT location_id (SCHEDROLES.1), never `user.role`, which is the
// ACTIVE studio's. This route is service-role: mig 236's RLS policy does
// nothing here, so this gate and the location filter in listRosterChanges are
// the whole tenant boundary.
//
// Query params:
//   location_id  uuid (required)
//   from, to     YYYY-MM-DD real calendar dates, inclusive, by SHIFT date
//                (block_date); at most 92 days
//
// Returns:
//   { success, data: { changes: [...], truncated } }   newest first
//   Names and times only. No rate, cost or contract-hours field is selected.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { uuidLike, isoDate, isRealCalendarDate, MANAGER_ROLES } from '@/lib/schemas'
import { listRosterChanges } from '@/lib/roster-change-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_SPAN_DAYS = 92

const QuerySchema = z.object({
  location_id: uuidLike,
  from: isoDate,
  to: isoDate,
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    location_id: url.searchParams.get('location_id'),
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
  })
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }
  const { location_id, from, to } = parsed.data

  // isoDate checks the SHAPE only. '2026-13-01' and '2026-02-30' pass it, and
  // would otherwise reach Postgres and come back as a 500.
  for (const [name, value] of [['from', from], ['to', to]]) {
    if (!isRealCalendarDate(value)) {
      return NextResponse.json({ success: false, error: `${name}: not a real date` }, { status: 400 })
    }
  }

  if (to < from) {
    return NextResponse.json({ success: false, error: 'to must be on or after from' }, { status: 400 })
  }
  // Whole days between two calendar dates, both anchored at UTC midnight so
  // DST cannot skew the count (the form the time-off POST uses for its cap).
  const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1
  if (spanDays > MAX_SPAN_DAYS) {
    return NextResponse.json({ success: false, error: `The range is limited to ${MAX_SPAN_DAYS} days` }, { status: 400 })
  }

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()
  const { changes, truncated, error } = await listRosterChanges(db, { locationId: location_id, from, to })
  // A failed read is a 500, never `changes: []`: an empty drawer says "nothing
  // changed", and that would be a lie.
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, data: { changes, truncated } })
}
