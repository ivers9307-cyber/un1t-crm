// CAMPAIGN.13 — send endpoint is now an enqueue, not a synchronous
// send. The actual sending happens in the run-campaigns cron, in
// chunks of 500/min, so:
//   - Operator gets an immediate 200 back; can navigate away.
//   - Large audiences (5k+) don't hit Vercel's function timeout.
//   - Throttle is enforced by cron cadence, not request thread.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { releasePreflight, releaseCampaign } from '@/lib/campaign-release'
import { conflict } from '@/lib/campaign-session-access'

export const dynamic = 'force-dynamic'

const PREFLIGHT_422 = ['email_hard_cap', 'wallet_empty']

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: campaign, error } = await db
    .from('campaigns')
    .select('id, location_id, status, name, subject, html_content')
    .eq('id', params.id)
    .single()
  if (error || !campaign) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, campaign.location_id)
  if (guard) return guard

  // COMMSFIX.D.5 — permission parity across the three email entry points. This
  // one, the REAL send to the whole audience, was the weakest: getCurrentUser
  // plus location access only, while send-test requires ADMIN_ROLES and the
  // composer's email-draft requires hasPermission('email'). A user with
  // location access but no email permission could broadcast by POSTing here,
  // yet got 403 'Admin only' on the safer test send — the gates were backwards.
  // Checked against the CAMPAIGN's location, not the session's active one.
  // Audit 2026-08-09 composer-ux.
  if (!hasPermissionForLocation(user, campaign.location_id, 'email')) {
    return NextResponse.json({ success: false, error: 'No email permission at this location' }, { status: 403 })
  }

  // The status, subject/body, org hard cap and wallet rules (MCPEMAIL.1:
  // one copy in src/lib/campaign-release.js, shared with the schedule and
  // approve routes). A refused status or content is 400; a cap or an empty
  // wallet is 422 with its code.
  const preflight = await releasePreflight(db, campaign)
  if (!preflight.ok) {
    if (PREFLIGHT_422.includes(preflight.code)) {
      return NextResponse.json({ success: false, error: preflight.message, code: preflight.code }, { status: 422 })
    }
    return NextResponse.json({ success: false, error: preflight.message }, { status: 400 })
  }

  // Flip to 'queued', compare-and-set on the releasable statuses: a campaign
  // the cron (or another tab) moved since our read is a 409 carrying its
  // status as it is now, never a silent re-queue.
  const release = await releaseCampaign(db, campaign)
  if (!release.ok) {
    if (release.code === 'conflict') return conflict(release.message, release.current_status)
    return NextResponse.json({ success: false, error: release.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    queued: true,
    message: 'Campaign queued — sending will start within 60 seconds.',
  })
}
