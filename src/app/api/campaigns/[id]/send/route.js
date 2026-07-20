// CAMPAIGN.13 — send endpoint is now an enqueue, not a synchronous
// send. The actual sending happens in the run-campaigns cron, in
// chunks of 500/min, so:
//   - Operator gets an immediate 200 back; can navigate away.
//   - Large audiences (5k+) don't hit Vercel's function timeout.
//   - Throttle is enforced by cron cadence, not request thread.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { getEmailCapStatus } from '@/lib/usage-caps'
import { checkSpend } from '@/lib/wallet-enforcement'

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
  const guard = assertLocationAccessOr404(user, campaign.location_id)
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

  // SAAS4-M2 — optional per-org HARD email-send cap. Mirrors the
  // WhatsApp blast preflight (blastBudgetBlockError): refuse to START
  // at cap, with a message that says exactly how to proceed. Sequences
  // and transactional sends are never capped. Fails OPEN inside the
  // helper — a metering failure must never block a campaign.
  const emailCap = await getEmailCapStatus({ locationId: campaign.location_id }, { db })
  if (emailCap.capped) {
    return NextResponse.json({
      success: false,
      error: `Monthly email hard cap reached (${emailCap.monthSends.toLocaleString()} of ${emailCap.capSends.toLocaleString()} sends this month). Raise or clear the cap in org settings to send this campaign.`,
      code: 'email_hard_cap',
    }, { status: 422 })
  }

  // INTEG-C3 — per-LOCATION prepaid wallet gate, beside (composing
  // with, never replacing) the per-ORG hard cap above: a tier-pinned
  // location whose monthly email allowance is used up AND whose wallet
  // is empty pauses marketing starts. Unpinned locations (every UN1T
  // location today) answer 'unpinned' and behave exactly as before.
  // Fail-open on any error — a billing bug must never block a send.
  try {
    const spend = await checkSpend(db, campaign.location_id, 'email_send', 'marketing')
    if (!spend.allow) {
      return NextResponse.json({
        success: false,
        error: 'Monthly email allowance is used up and the prepaid wallet is empty — marketing sends are paused. Top up the wallet to send this campaign.',
        code: 'wallet_empty',
      }, { status: 422 })
    }
  } catch { /* fail open — checkSpend already never throws */ }

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
