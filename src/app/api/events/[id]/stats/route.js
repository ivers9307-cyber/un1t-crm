// /api/events/[id]/stats — HOSTSTATS.1
//
// GET — staff read an event's signup numbers (the same lib the host route
// uses). Manager+ holding `races` AT THE EVENT'S studio; an event outside
// the caller's studios is 404 (never 403, so ids cannot be enumerated).

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { loadEventStats } from '@/lib/event-stats'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'races')) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  if (!uuidLike.safeParse(params.id).success) return notFound()

  const db = createServerClient()
  const { data: race } = await db.from('race_events').select('id, location_id').eq('id', params.id).maybeSingle()
  if (!race?.location_id) return notFound()
  const guard = assertLocationAccessOr404(user, race.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, race.location_id, 'races') || !hasRoleAtLocation(user, race.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const result = await loadEventStats(db, race.id)
  if (!result.ok) {
    logWarn('event-stats', 'stats read failed', { err: result.error, eventId: race.id })
    return NextResponse.json({ success: false, error: 'Unavailable' }, { status: 503 })
  }
  return NextResponse.json({ success: true, data: result.stats })
}
