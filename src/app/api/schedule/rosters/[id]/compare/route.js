// src/app/api/schedule/rosters/[id]/compare/route.js
// SNAPSHOT.1 — GET /api/schedule/rosters/[id]/compare
//
// A published (or since superseded) roster as it was PUBLISHED (its
// roster_publish_snapshots row, mig 634), as it is ROSTERED NOW (the live
// shift_blocks + shift_assignments) and as ARRIVED (arrived_at, with the
// attendance report's back-to-back carry-over). Per shift and per coach: both
// windows, the change (unchanged / moved / added / removed after publish), the
// arrival, and an ADVISORY "no arrival recorded" flag on ended shifts. Nothing
// here alerts anyone.
//
// Gate (the blocks/[id] shape): a manager role somewhere, else 403; the
// roster by id, else 404; an outsider to the roster's studio gets 404 (the id
// is not confirmed); a member without a manager role THERE gets 403. This
// route is service-role: that gate and the location pins inside
// loadRosterComparison are the whole tenant boundary.
//
// Query:
//   from, to   optional YYYY-MM-DD real dates, the period on screen; clipped to
//              the published period
//   against    optional snapshot id at the same studio to compare with instead
//              of this roster's own (the first publish of the week, say)
//
// Names, times, hours and arrival stamps only. Never a rate or a cost.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { uuidLike, realIsoDate, MANAGER_ROLES } from '@/lib/schemas'
import { loadRosterComparison } from '@/lib/roster-snapshot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  from: realIsoDate.optional(),
  to: realIsoDate.optional(),
  against: uuidLike.optional(),
})

function fail(status, error) {
  return NextResponse.json({ success: false, error }, { status })
}

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) return fail(403, 'Unauthorized')

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
    against: url.searchParams.get('against') || undefined,
  })
  if (!parsed.success) {
    return fail(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }
  const { from, to, against } = parsed.data
  if (from && to && to < from) return fail(400, 'to must be on or after from')

  // A malformed id is simply not a roster: 404, never Postgres's 22P02 text.
  if (!uuidLike.safeParse(params.id).success) return fail(404, 'Roster not found')

  const db = createServerClient()
  const { data: roster, error: rosterErr } = await db
    .from('rosters')
    .select('id, location_id, status, period_start, period_end, published_at, published_by')
    .eq('id', params.id)
    .maybeSingle()
  if (rosterErr) return fail(500, 'The roster could not be read')
  if (!roster) return fail(404, 'Roster not found')

  const notHere = assertLocationAccessOr404(user, roster.location_id)
  if (notHere) return notHere
  if (!hasRoleAtLocation(user, roster.location_id, MANAGER_ROLES)) return fail(403, 'Forbidden')

  if (roster.status === 'draft') {
    return fail(409, 'This roster is a draft waiting for approval, so nothing has been published to compare.')
  }

  const result = await loadRosterComparison(db, {
    roster,
    againstId: against ?? null,
    from: from ?? null,
    to: to ?? null,
    nowMs: Date.now(),
  })
  if (result.notFound) return fail(404, 'Snapshot not found')
  // A failed read is a 500, never an empty comparison: "nothing changed" would
  // be a lie. loadRosterComparison has already logged it.
  if (result.error || !result.data) return fail(500, 'The comparison could not be read')
  return NextResponse.json({ success: true, data: result.data })
}
