// GRID.1 — GET /api/schedule/grid?location_id=<uuid>&start_date=<YYYY-MM-DD>
//
// The coach-by-day grid's one read (Schedule → Week → Coaches). For the Mon-Sun
// week holding start_date: the studio's team plus anyone holding a shift there
// that week (name, employment type, contracted hours for employees), and every
// live shift those people have from the Sunday before to the Monday after, here
// and at the other studios of the same organisation. The arithmetic (totals,
// admin balance, advisories) happens in the browser, in the pure
// src/lib/roster-grid-model.js, over this one snapshot plus the leave and
// availability the calendar already holds.
//
// Gate: MANAGER_ROLES, then assertLocationAccess on the caller-supplied
// location_id (a query-param route: a studio outside the caller's assignments
// is a 403, as week-cost), then MANAGER_ROLES AT that studio (SCHEDROLES.1:
// never user.role). The date is a real calendar date (DATECHECK.1).
//
// Contracted hours: owner, manager and master AT the studio only
// (ADMIN_ROLES; GRID.1 review 1, the CANDIDATES.1 decision). A head coach
// gets the grid with contract_visible false and no contracted_hours key.
//
// Hours and times only. No rate, salary, cost or euro figure is read or sent.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { uuidLike, realIsoDate, MANAGER_ROLES, ADMIN_ROLES } from '@/lib/schemas'
import { mondayOf } from '@/lib/payroll'
import { loadRosterGrid } from '@/lib/roster-grid-data'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  location_id: uuidLike,
  start_date: realIsoDate,
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    location_id: url.searchParams.get('location_id'),
    start_date: url.searchParams.get('start_date'),
  })
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }
  const { location_id, start_date } = parsed.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden — needs a manager role at that location' }, { status: 403 })
  }

  // GRID.1 review 1 — contracted hours (and so the admin balance) go to
  // owner, manager and master only (the CANDIDATES.1 decision), judged AT
  // this studio. A head coach keeps the grid with the contract hidden.
  const showContract = hasRoleAtLocation(user, location_id, ADMIN_ROLES)

  const db = createServerClient()
  const { data, error } = await loadRosterGrid(db, { locationId: location_id, weekStart: mondayOf(start_date), showContract })
  if (error) {
    logError('api/schedule/grid', 'grid read failed', { location_id, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not load the coach grid' }, { status: 500 })
  }
  if (showContract) return NextResponse.json({ success: true, data })
  // The reader neither reads nor returns the column when told not to; this
  // strip is the second lock, so no future reader change can leak it here.
  return NextResponse.json({
    success: true,
    data: {
      ...data,
      contract_visible: false,
      members: (data?.members || []).map(({ contracted_hours: _hidden, ...m }) => m),
    },
  })
}
