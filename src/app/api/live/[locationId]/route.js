// GET /api/live/[locationId]
//
// Returns the current state of all open HR sessions at the location
// + the list of available straps the bridge is broadcasting that
// aren't yet routed. The coach view polls this every ~2s.
//
// Auth: any staff at the location can view. Non-staff (customers,
// staff at other locations) get 403.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getLiveSessions, getAvailableStraps } from '@/lib/live-class'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  }
  const locationId = params.locationId
  if (!user.isMaster && !(user.locationIds || []).includes(locationId)) {
    return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
  }

  const db = createServerClient()
  const [sessions, availableStraps] = await Promise.all([
    getLiveSessions(db, locationId),
    getAvailableStraps(db, locationId),
  ])

  return NextResponse.json({
    ok: true,
    server_time: new Date().toISOString(),
    sessions,
    available_straps: availableStraps,
  })
}
