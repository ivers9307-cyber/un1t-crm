// /api/host/events/[id]/ratings — HOSTPAGE.2
//
// GET — a host reads every rating of ONE of their own events (hidden ones
// included, so they can un-hide), each with the attendee's first name only,
// plus the public summary the /h page shows (ratingSummary: null under three
// public ratings). Another host's event is 404.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { ratingSummary } from '@/lib/event-ratings'
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

  const { data, error } = await db
    .from('event_ratings')
    .select('id, rating, comment, is_public, created_at, contact:contact_id ( first_name )')
    .eq('race_event_id', race.id)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) {
    logWarn('host-event-ratings', 'ratings read failed', { err: error, eventId: race.id })
    return NextResponse.json({ success: false, error: 'Unavailable' }, { status: 503 })
  }
  const rows = Array.isArray(data) ? data : []
  return NextResponse.json({
    success: true,
    data: {
      ratings: rows.map((r) => ({ id: r.id, rating: r.rating, comment: r.comment ?? null, is_public: r.is_public === true, created_at: r.created_at, author: String(r.contact?.first_name || '').trim() })),
      summary: ratingSummary(rows),
    },
  })
}
