import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, getUserLocationIds, hasRoleAtLocation } from '@/lib/auth'
import { fetchApiShiftRows } from '@/lib/roster-read'
import { fetchOwnOpenSwaps, annotateOwnOpenSwaps, ownShiftIds } from '@/lib/shift-open-swaps'
import { fetchOwnArrivalFacts, annotateOwnArrivals, ownLocationIds } from '@/lib/shift-arrivals'
import { MANAGER_ROLES, isRealCalendarDate } from '@/lib/schemas'
import { logError } from '@/lib/log'

// RETIRE-SHIFTS-MIRROR.5d — GET reads the Roster v2 model (shift_blocks +
// shift_assignments) directly via fetchApiShiftRows, normalised to the legacy
// shift shape so the only consumer (the mobile schedule) sees no change. The
// shift_assignment_id it used to stitch in via a second query is now just the
// row id. (The POST/PUT/DELETE write handlers were removed in 5; the legacy
// public.shifts table no longer has any reader after this.)

// GET /api/schedule/shifts?location_id=xxx&start_date=2026-04-27&end_date=2026-05-03&profile_id=xxx
export async function GET(request) {
  const user = await getCurrentUser()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const startDate = searchParams.get('start_date')
  const endDate = searchParams.get('end_date')
  const profileId = searchParams.get('profile_id')
  // ARRIVALSHOW.1 review 3 — the arrival facts cost three reads, so they are
  // read only when the caller asks: ?include=arrival (a comma list), sent by
  // the phone's Schedule tab Me view. Everyone else (old phones, the Team
  // view, the Home tab, web) gets arrival: null and no extra read.
  const includeArrival = (searchParams.get('include') || '').split(',').map((x) => x.trim()).includes('arrival')
  // DATECHECK.1 — these bounds reach Postgres as they are, and it refuses
  // 2026-02-30 (the route used to hand back its error text as the 400). Refuse
  // it here, in change-log's words. Absent or empty = no bound, as before.
  for (const [name, value] of [['start_date', startDate], ['end_date', endDate]]) {
    if (value && !isRealCalendarDate(value)) {
      return NextResponse.json({ success: false, error: `${name}: not a real date` }, { status: 400 })
    }
  }
  const db = createServerClient()

  // Specific location, or fall back to all of the caller's own locations.
  const locationIds = locationId ? [locationId] : getUserLocationIds(user)
  if (locationIds.length === 0) {
    return NextResponse.json({ success: true, data: [] })
  }

  const { rows, error } = await fetchApiShiftRows(db, {
    locationIds,
    startDate,
    endDate,
    profileId,
    // ROSTER-FIX.1 (D1) — a coach never sees a draft shift. Managers keep
    // drafts here because the calendar and ManageMode read the same feed.
    //
    // COACHSCOPE.1 — judged PER ROW against the caller's role at that row's
    // location, not `user.role`. `user.role` is the ACTIVE location's role, so
    // a head coach at Hatch reading `?location_id=<Stillorgan>` (where they are
    // plain staff) got Stillorgan's drafts, and with no location_id every
    // studio's rows took the active one's verdict. A non-manager row is also
    // slimmed: no colleague email / notes / partial_reason
    // (slimShiftRowForCoach).
    viewer: {
      id: user.id,
      isManagerAt: (locId) => hasRoleAtLocation(user, locId, MANAGER_ROLES),
    },
  })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // COVERLOOP.2 — the caller's OWN rows say whether a swap is open on them
  // (the phone's "Swap pending" chip). Keyed on the caller AND bounded to the
  // caller's own assignment ids in this payload; no own rows = no query.
  // ARRIVALSHOW.1 — and what the app recorded as their arrival (the Schedule
  // tab's arrival line). Same bounds, same rule: own rows only, never throws,
  // and an unreadable arrival is null on every row, never "not recorded".
  const ownIds = ownShiftIds(rows, user.id)
  const [ownOpenSwaps, arrivalFacts] = await Promise.all([
    fetchOwnOpenSwaps(db, user.id, ownIds),
    includeArrival
      ? fetchOwnArrivalFacts(db, user.id, ownIds, ownLocationIds(rows, user.id))
      : { stamps: null, timezones: null, tracked: null },
  ])
  const withSwaps = annotateOwnOpenSwaps(rows, ownOpenSwaps, user.id)
  // Review 3 — the arrival line is never worth the roster: if the annotate
  // itself throws, every row goes out with arrival: null (unknown, which the
  // phone renders as nothing) and the failure is logged.
  let data
  try {
    data = annotateOwnArrivals(withSwaps, arrivalFacts, user.id)
  } catch (err) {
    logError('schedule', 'own arrival annotate failed; shifts returned without arrival', { err: err?.message || String(err) })
    data = withSwaps.map((r) => ({ ...r, arrival: null }))
  }
  return NextResponse.json({ success: true, data })
}
