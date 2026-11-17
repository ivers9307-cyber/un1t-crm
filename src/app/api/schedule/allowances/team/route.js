// LEAVEBAL.1 — GET /api/schedule/allowances/team?year=
//
// Every active member of staff at the caller's ACTIVE studio with the year's
// holiday allowance (days) and time-in-lieu balance (hours), in one call, for
// Schedule › Leave balances. The figures are the per-person
// GET /api/schedule/allowances ones, read in batches
// (src/lib/team-leave-balances.js).
//
// Gate: signed in, the studio is one of the caller's (assertLocationAccess),
// and a manager-tier role AT it (MANAGER_ROLES via hasRoleAtLocation; master
// everywhere). Scope: the staff list is profile_locations at that studio
// only, so nobody from another studio can appear. A part that could not be
// read is null and named in `unreadable`, never 0.
//
// The response also says what the caller may change from the screen:
// `can_edit_allowance` (PUT /api/schedule/allowances: MANAGER_ROLES) and
// `can_record_lieu` (POST/DELETE /api/schedule/allowances/lieu: ADMIN_ROLES
// at this studio; a head coach reads balances but records no lieu).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
import { MANAGER_ROLES, ADMIN_ROLES } from '@/lib/schemas'
import { parseAllowanceYear } from '@/lib/allowance-year'
import { staffZoneOfUser } from '@/lib/staff-zone'
import { todayStrIn } from '@/lib/location-time'
import { readTeamLeaveBalances } from '@/lib/team-leave-balances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = user.activeLocation?.id || null
  if (!locationId) return NextResponse.json({ success: false, error: 'Choose a studio first' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only managers at this studio can see the team\'s leave balances.' }, { status: 403 })
  }

  const zone = staffZoneOfUser(user)
  const { searchParams } = new URL(request.url)
  const { year, error: yearError } = parseAllowanceYear(searchParams.get('year'), zone)
  if (yearError) return NextResponse.json({ success: false, error: yearError }, { status: 400 })

  const db = createServerClient()
  const { rows, unreadable, error } = await readTeamLeaveBalances(db, locationId, year)
  if (error) {
    console.error('[allowances/team] staff list unreadable', error.message)
    return NextResponse.json({ success: false, error: 'Could not read the studio\'s staff list' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: {
      location_id: locationId,
      year: Number(year),
      today: todayStrIn(zone),
      can_edit_allowance: true,
      can_record_lieu: hasRoleAtLocation(user, locationId, ADMIN_ROLES),
      unreadable,
      rows,
    },
  })
}
