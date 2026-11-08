// /api/host/events/[id]/stats — HOSTSTATS.1
//
// GET — a host reads ONE of their own events' signup numbers (page views,
// visitors, bookings, conversion, sources, waitlist; loadEventStats). Another
// host's event is 404, so ids cannot be enumerated across hosts.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { loadEventStats } from '@/lib/event-stats'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: race } = await db.from('race_events').select('id, host_id').eq('id', params.id).maybeSingle()
  if (!race || race.host_id !== session.host.id) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const result = await loadEventStats(db, race.id)
  if (!result.ok) {
    logWarn('host-event-stats', 'stats read failed', { err: result.error, eventId: race.id })
    return NextResponse.json({ success: false, error: 'Unavailable' }, { status: 503 })
  }
  return NextResponse.json({ success: true, data: result.stats })
}
