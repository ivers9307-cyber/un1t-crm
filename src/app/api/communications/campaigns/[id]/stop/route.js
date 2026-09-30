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
// Gate (D7): email at the campaign's studio.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { loadCampaignForUser, conflict, serverError, STATUS_CHANGED } from '@/lib/campaign-session-access'

export const dynamic = 'force-dynamic'

const IN_FLIGHT = ['queued', 'sending']

export async function POST(_request, props) {
  const { id } = await props.params
  const user = await getCurrentUser()
  const db = createServerClient()
  const { campaign, response } = await loadCampaignForUser(db, user, id, 'id, location_id, status')
  if (response) return response

  let query
  let result
  if (campaign.status === 'scheduled') {
    query = db.from('campaigns')
      .update({ status: 'draft', scheduled_at: null })
      .eq('id', campaign.id)
      .eq('status', 'scheduled')
    result = { status: 'draft', cancel_requested_at: null }
  } else if (IN_FLIGHT.includes(campaign.status)) {
    const at = new Date().toISOString()
    query = db.from('campaigns')
      .update({ cancel_requested_at: at })
      .eq('id', campaign.id)
      .in('status', IN_FLIGHT)
    result = { status: campaign.status, cancel_requested_at: at }
  } else {
    return conflict(`This campaign is ${campaign.status || 'in an unknown state'}, so there is nothing to stop.`, campaign.status)
  }

  const { data, error } = await query.select('id')
  if (error) return serverError(error.message)
  if (!data || data.length === 0) return conflict(STATUS_CHANGED, campaign.status)

  return NextResponse.json({ success: true, data: result })
}
