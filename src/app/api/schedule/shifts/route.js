import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, getUserLocationIds } from '@/lib/auth'
import { fetchApiShiftRows } from '@/lib/roster-read'

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
  })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data: rows })
}
