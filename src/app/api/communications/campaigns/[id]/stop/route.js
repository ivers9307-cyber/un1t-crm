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
// Gate (D7): email at the campaign's studio.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { loadCampaignForUser, conflict, serverError, STATUS_CHANGED, currentStatus } from '@/lib/campaign-session-access'

export const dynamic = 'force-dynamic'

const IN_FLIGHT = ['queued', 'sending']

// Stamp cancel_requested_at on a campaign that is queued or sending.
// Resolves to { ok, error }.
async function requestCancel(db, id, at) {
  const { data, error } = await db.from('campaigns')
    .update({ cancel_requested_at: at })
    .eq('id', id)
    .in('status', IN_FLIGHT)
    .select('id')
  if (error) return { ok: false, error }
  return { ok: Array.isArray(data) && data.length > 0, error: null }
}

export async function POST(_request, props) {
  const { id } = await props.params
  const user = await getCurrentUser()
  const db = createServerClient()
  const { campaign, response } = await loadCampaignForUser(db, user, id, 'id, location_id, status')
  if (response) return response

  if (campaign.status === 'scheduled') {
    const { data, error } = await db.from('campaigns')
      .update({ status: 'draft', scheduled_at: null })
      .eq('id', campaign.id)
      .eq('status', 'scheduled')
      .select('id')
    if (error) return serverError(error.message)
    if (data && data.length > 0) {
      return NextResponse.json({ success: true, data: { status: 'draft', cancel_requested_at: null } })
    }
    // Zero rows: the run-campaigns cron promoted it (scheduled → queued)
    // between our read and our write. The operator asked to STOP, so stop the
    // send it has become rather than answer "reload" while it goes out.
    const now = await currentStatus(db, campaign.id, campaign.status)
    if (!IN_FLIGHT.includes(now)) return conflict(STATUS_CHANGED, now)
    const at = new Date().toISOString()
    const cancel = await requestCancel(db, campaign.id, at)
    if (cancel.error) return serverError(cancel.error.message)
    if (!cancel.ok) return conflict(STATUS_CHANGED, await currentStatus(db, campaign.id, now))
    return NextResponse.json({ success: true, data: { status: now, cancel_requested_at: at } })
  }

  if (IN_FLIGHT.includes(campaign.status)) {
    const at = new Date().toISOString()
    const cancel = await requestCancel(db, campaign.id, at)
    if (cancel.error) return serverError(cancel.error.message)
    if (!cancel.ok) return conflict(STATUS_CHANGED, await currentStatus(db, campaign.id, campaign.status))
    return NextResponse.json({ success: true, data: { status: campaign.status, cancel_requested_at: at } })
  }

  return conflict(`This campaign is ${campaign.status || 'in an unknown state'}, so there is nothing to stop.`, campaign.status)
}
