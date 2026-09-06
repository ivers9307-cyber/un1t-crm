// POST /api/host/emails/[id]/unschedule — HOST-SCHEDULE.1.
//
// CAS scheduled → draft with scheduled_for cleared. schedule_error is left
// alone (it is only ever set by a refused fire, and this path is the host
// cancelling). 0 rows = it already fired (or was never scheduled, or is
// not this host's) → 409; the composer reloads and shows the real state.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CAMPAIGN_COLUMNS = 'id, subject, status, audience_kind, audience_event_id, email_type, recipient_count, sent_count, created_at, sent_at, scheduled_for, schedule_error'

export async function POST(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: rows, error } = await db
    .from('host_campaigns')
    .update({ status: 'draft', scheduled_for: null })
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .eq('status', 'scheduled')
    .select(CAMPAIGN_COLUMNS)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!rows || rows.length === 0) {
    return NextResponse.json({ success: false, error: 'This email is no longer scheduled.' }, { status: 409 })
  }
  return NextResponse.json({ success: true, data: rows[0] })
}
