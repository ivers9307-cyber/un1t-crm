// POST /api/host/events/[id]/unpublish — host takes their OWN published event
// off sale (HOST-PORTAL.10). Sets status back to 'draft', which every public
// gate keys on (visibility + booking require active AND status='published'),
// so NEW sales stop instantly. Existing attendees keep their tickets — refunds
// are staff-only and this route never touches payments. To go live again the
// host edits and submits for review as normal.
//
// Tenancy mirrors every /api/host route: getCurrentHost() then
// race.host_id === session.host.id, 404 otherwise (ids can't be enumerated).
import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select('id, host_id, status, name')
    .eq('id', params.id)
    .maybeSingle()
  if (!race || race.host_id !== session.host.id) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (race.status !== 'published') {
    return NextResponse.json(
      { success: false, error: `Event is ${race.status}, not published.` },
      { status: 409 }
    )
  }

  // CAS on the current status so two racing unpublishes (or an unpublish racing
  // a staff rejection) can't both "win" — 0 rows updated means someone else
  // moved the status first.
  const { data: updated, error } = await db
    .from('race_events')
    .update({ status: 'draft' })
    .eq('id', race.id)
    .eq('status', 'published')
    .select('id')
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Event is no longer published.' },
      { status: 409 }
    )
  }

  return NextResponse.json({ success: true, data: { id: race.id, status: 'draft' } })
}
