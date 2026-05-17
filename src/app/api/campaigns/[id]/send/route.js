// CAMPAIGN.13 — send endpoint is now an enqueue, not a synchronous
// send. The actual sending happens in the run-campaigns cron, in
// chunks of 500/min, so:
//   - Operator gets an immediate 200 back; can navigate away.
//   - Large audiences (5k+) don't hit Vercel's function timeout.
//   - Throttle is enforced by cron cadence, not request thread.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: campaign, error } = await db
    .from('campaigns')
    .select('id, location_id, status, name')
    .eq('id', params.id)
    .single()
  if (error || !campaign) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, campaign.location_id)
  if (guard) return guard

  // Only draft / scheduled campaigns can be sent. 'sending' /
  // 'sent' / 'cancelled' all reject — the operator should clone
  // the campaign if they want to send it again.
  if (!['draft', 'scheduled'].includes(campaign.status)) {
    return NextResponse.json({
      success: false,
      error: `Campaign is '${campaign.status}', cannot send`,
    }, { status: 400 })
  }

  // Flip to 'queued' — the run-campaigns cron will pick it up on
  // its next tick (typically within 60s) and start the populate
  // → send chunks state machine.
  const { error: updateErr } = await db
    .from('campaigns')
    .update({
      status: 'queued',
      cancel_requested_at: null,    // clear any stale cancel flag from a previous abort
      scheduled_at: null,           // send-now overrides any scheduled time
    })
    .eq('id', params.id)

  if (updateErr) {
    return NextResponse.json({ success: false, error: updateErr.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    queued: true,
    message: 'Campaign queued — sending will start within 60 seconds.',
  })
}
