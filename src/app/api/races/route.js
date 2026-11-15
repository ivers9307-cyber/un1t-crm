// /api/races
//
// List race events. Manager+ permission. Scoped to the caller's studios
// (mig 082). The phone's race-day control reads it (mobile/lib/races-api.js).
//
// RACESFORK.1 (audit 2026-11-15, item 11): this used to also CREATE events,
// and /api/races/[id] and /api/races/[id]/teams edited, deleted and added
// teams. They were older copies of /api/events/* without the host, kind,
// venue or find-a-team handling, and stayed reachable because a filesystem
// route always wins over the next.config.js rewrites meant to alias them.
// They are deleted: /api/races/:id(/teams) now reach /api/events through the
// rewrites, and POST here answers 405. Create events through /api/events.

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermissionAtAnyLocation(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const url = new URL(request.url)
  const filterLocation = url.searchParams.get('location_id')

  const db = createServerClient()
  // ROLESWEEP.1b — "every location I belong to" narrows to the ones where
  // the caller is Manager+ AND holds `races` THERE, not at the active studio.
  const locationIds = filterLocation
    ? [filterLocation]
    : getUserLocationIds(user).filter((id) => hasRoleAtLocation(user, id, MANAGER_ROLES) && hasPermissionForLocation(user, id, 'races'))
  if (locationIds.length === 0) {
    return NextResponse.json({ success: true, data: [] })
  }
  if (filterLocation) {
    const guard = assertLocationAccess(user, filterLocation)
    if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    // ROLESWEEP.1b — judged at ?location_id, not the caller's active studio.
    if (!hasRoleAtLocation(user, filterLocation, MANAGER_ROLES)) {
      return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
    }
    if (!hasPermissionForLocation(user, filterLocation, 'races')) {
      return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
    }
  }

  const { data, error } = await db
    .from('race_events')
    .select(`
      id, location_id, name, slug, description, race_date,
      registration_opens_at, registration_closes_at,
      allowed_team_sizes, active, created_at, updated_at,
      member_pricing_enabled, member_fee_cents, non_member_fee_cents,
      members_only, payment_currency,
      waves:race_waves ( id, start_time, capacity, label, display_order ),
      registrations:race_registrations ( id, status, race_started_at, race_finished_at, wave_id, team_composition )
    `)
    .in('location_id', locationIds)
    .order('race_date', { ascending: false })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || [] })
}
