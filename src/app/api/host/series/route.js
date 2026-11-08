// /api/host/series — HOSTSERIES.1
//
// GET — the host's own series, each with how many published dates are still
// to come (today on the host's anchor clock).

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { listHostSeries } from '@/lib/event-series'
import { getLocationZone, DEFAULT_TZ } from '@/lib/location-time'
import { todayIsoIn } from '@shared/events'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  // The host session carries no anchor id (HOST_PORTAL_COLS); read it.
  const { data: host } = await db.from('event_hosts').select('anchor_location_id').eq('id', session.host.id).maybeSingle()
  let zone = DEFAULT_TZ
  try {
    zone = await getLocationZone(db, host?.anchor_location_id || null)
  } catch (err) {
    logWarn('host-series', 'anchor zone unreadable; counting on the default zone', { err, hostId: session.host.id })
  }
  const data = await listHostSeries(db, { hostId: session.host.id, today: todayIsoIn(zone) })
  return NextResponse.json({ success: true, data })
}
