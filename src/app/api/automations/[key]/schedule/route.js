// GET /api/automations/[key]/schedule?location_id=<uuid>
//
// CLASS-CLIMATE.1 — read the synced class-schedule "spine"
// (class_occurrences) for a location so the operator can SEE the
// timetable the automation runs off. Read-only; the cron / Run-now keep
// the table fresh. class_climate, bathroom_climate and screen_mode use it.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth signs the caller in (a signed-out call now answers its 401); the
// studio is the query's location_id, so the role checks stay here in order.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  // ROLESWEEP.1a — coarse pre-check; the role is judged at the location below.
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const key = params?.key
  if (key !== 'class_climate' && key !== 'bathroom_climate' && key !== 'screen_mode') {
    return NextResponse.json({ success: false, error: 'not supported for this automation' }, { status: 400 })
  }

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  // From 30 min ago (so a class that just started still shows) forward.
  const sinceIso = new Date(Date.now() - 30 * 60_000).toISOString()
  const { data, error } = await db
    .from('class_occurrences')
    .select('glofox_event_id, name, starts_at, ends_at, capacity, instructor, synced_at')
    .eq('location_id', locationId)
    .gte('starts_at', sinceIso)
    .is('cancelled_at', null)
    .order('starts_at', { ascending: true })
    .limit(50)
  if (error) {
    logError('automations', 'class schedule read failed', { locationId, err: error })
    return NextResponse.json({ success: false, error: 'Could not load the class schedule.' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    classes: data || [],
    last_synced: data?.[0]?.synced_at || null,
  })
})
