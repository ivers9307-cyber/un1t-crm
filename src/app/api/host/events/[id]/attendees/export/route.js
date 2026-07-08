// GET /api/host/events/[id]/attendees/export
//
// Host-portal attendee CSV — the host's OWN event only. Byte-identical to the
// staff export (/api/events/[id]/teams/export) via @/lib/attendee-export; the
// only difference is the gate: getCurrentHost() + race.host_id === host.id.
// A missing OR not-yours event returns 404 (not 403) so a host can't probe
// another host's event ids. (HOST-PORTAL.1)

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { fetchEventAttendees, attendeeCsvResponse } from '@/lib/attendee-export'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select('id, host_id, name, slug, race_date')
    .eq('id', params.id)
    .maybeSingle()
  // host_id must equal the caller's host. A null host_id (internal event) never
  // matches a real host id, so those 404 too.
  if (!race || race.host_id !== session.host.id) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  try {
    const regs = await fetchEventAttendees(db, params.id)
    return attendeeCsvResponse(race, regs)
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
