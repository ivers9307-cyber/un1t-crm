// GET /api/automations/[key]/schedule?location_id=<uuid>
//
// CLASS-CLIMATE.1 — read the synced class-schedule "spine"
// (class_occurrences) for a location so the operator can SEE the
// timetable the automation runs off. Read-only; the cron / Run-now keep
// the table fresh. class_climate and bathroom_climate use it today.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { key } = await params
  if (key !== 'class_climate' && key !== 'bathroom_climate') {
    return NextResponse.json({ success: false, error: 'not supported for this automation' }, { status: 400 })
  }

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
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
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({
    success: true,
    classes: data || [],
    last_synced: data?.[0]?.synced_at || null,
  })
}
