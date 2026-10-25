// RUNWAY.1 — GET /api/schedule/runway
//
// The roster runway for ONE location: the first week inside a 10-day horizon
// that is unpublished or has a shift with no coach, or null when every week is
// ready. Drives the mobile Studio dashboard chip. (The web Today page calls
// fetchRosterRunways directly; it is a server component.)
//
// A route rather than a direct mobile Supabase read on purpose: the answer is
// ABOUT unpublished blocks, which coaches must never see, and mobile's
// authenticated client is RLS-bound. The gate below is the only thing that
// matters here, since a service-role route gets no RLS at all.
//
// Gate: MANAGER_ROLES AT location_id (hasRoleAtLocation, never `user.role`,
// which is the ACTIVE studio's role), after assertLocationAccess. location_id
// is a query param, so a foreign location is a 403; the 404 rule is for
// detail routes whose id comes from the path.
//
// Query params:  location_id  uuid (required)
// Returns:       { success, data: { runway: null | { weekStart, daysAway,
//                  severity, blocks, staffed, underMin, published, unstaffed,
//                  unpublished } } }

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { fetchRosterRunways } from '@/lib/roster-runway-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuerySchema = z.object({ location_id: uuidLike })

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({ location_id: url.searchParams.get('location_id') })
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }
  const { location_id } = parsed.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const res = await fetchRosterRunways(createServerClient(), [location_id])
  if (!res.success) {
    return NextResponse.json({ success: false, error: res.error }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { runway: res.data.byLocation[location_id] ?? null } })
}
