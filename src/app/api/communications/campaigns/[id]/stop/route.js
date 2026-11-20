// MEMBERWRITESWEEP.1e — POST /api/communications/campaigns/[id]/stop: stop a
// campaign (session auth; the editor's Stop, the detail page's Unschedule and
// Stop).
//
// Replaces two browser-direct updates that chose their branch from a status
// held in React state. The server reads the CURRENT status and narrows the
// write to it:
//   scheduled        → back to draft, scheduled_at cleared (no longer a
//                      promotion candidate for the run-campaigns cron)
//   queued | sending → cancel_requested_at stamped; the cron sees it between
//                      chunks and moves the campaign to 'cancelled'
//   anything else    → 409, nothing written
// If the cron promotes a scheduled campaign to queued between the read and the
// write, the unschedule touches nothing and the stop becomes a cancel request
// on the send it turned into (never a "reload" while it goes out). Every 409
// carries the status as it is now.
// Gate (D7): email at the campaign's studio. The stop rules themselves are
// stopCampaign in src/lib/campaign-release.js (MCPEMAIL.1).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadCampaignForUser, conflict, serverError } from '@/lib/campaign-session-access'
import { stopCampaign } from '@/lib/campaign-release'

export const dynamic = 'force-dynamic'

// The studio is the CAMPAIGN's, so withAuth only signs the caller in;
// loadCampaignForUser keeps the 404s and the email-there 403.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const id = params?.id
  const { campaign, response } = await loadCampaignForUser(db, user, id, 'id, location_id, status')
  if (response) return response

  const stop = await stopCampaign(db, campaign)
  if (!stop.ok) {
    if (stop.code === 'error') {
      logError('campaigns', 'stop failed', { campaignId: campaign.id, message: stop.message })
      return serverError('Could not stop the campaign. Try again.')
    }
    return conflict(stop.message, stop.current_status)
  }
  return NextResponse.json({ success: true, data: { status: stop.status, cancel_requested_at: stop.cancel_requested_at } })
})
