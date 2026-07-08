// Host submits a draft/rejected event for UN1T review. (HOST-PORTAL.3)
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
  const { data: event } = await db.from('race_events').select('id, host_id, status').eq('id', params.id).maybeSingle()
  if (!event || event.host_id !== session.host.id) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (event.status !== 'draft' && event.status !== 'rejected') {
    return NextResponse.json({ success: false, error: `Cannot submit an event that is ${event.status}.` }, { status: 409 })
  }

  const { error } = await db.from('race_events').update({
    status: 'pending_review',
    submitted_at: new Date().toISOString(),
    rejected_reason: null,
  }).eq('id', event.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: { id: event.id, status: 'pending_review' } })
}
