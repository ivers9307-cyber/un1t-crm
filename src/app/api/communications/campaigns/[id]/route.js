// MEMBERWRITESWEEP.1e — the campaign editor's session routes for one campaign.
//
//   GET    → the progress poll: status, total_sent, total_recipients,
//            cancel_requested_at (the editor polls it every 3 s while a send
//            is in flight; it used to read campaigns from the browser)
//   PUT    → save the content of a draft or scheduled campaign
//   DELETE → delete a draft or scheduled campaign
//
// All three replace browser-direct reads and writes on campaigns that ran
// under nothing but the mig 014 membership policy. Gate (D7): email at the
// campaign's studio (loadCampaignForUser). The n8n twin is /api/campaigns/[id]
// (Bearer only). Writes are narrowed to the status they were judged on, so a
// campaign the run-campaigns cron moved in between is refused (409), never
// rewritten; the DB triggers campaigns_lock_sent_content and
// campaigns_block_sent_delete (migs 522/523) are the second lock.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import {
  EDITABLE_CAMPAIGN_STATUSES, isCampaignContentEditable, campaignLockedReason, campaignUndeletableReason,
} from '@/lib/campaign-editability'
import {
  loadCampaignForUser, CampaignContentSchema, contentPatch, audienceFilterRefusal,
  conflict, serverError, STATUS_CHANGED, CHECK_VIOLATION,
} from '@/lib/campaign-session-access'

export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const { id } = await props.params
  const user = await getCurrentUser()
  const db = createServerClient()
  const { campaign, response } = await loadCampaignForUser(db, user, id,
    'id, location_id, status, total_sent, total_recipients, cancel_requested_at')
  if (response) return response

  return NextResponse.json({
    success: true,
    data: {
      status: campaign.status,
      total_sent: campaign.total_sent,
      total_recipients: campaign.total_recipients,
      cancel_requested_at: campaign.cancel_requested_at,
    },
  })
}

export async function PUT(request, props) {
  const { id } = await props.params
  const user = await getCurrentUser()
  const db = createServerClient()
  const { campaign, response } = await loadCampaignForUser(db, user, id, 'id, location_id, status')
  if (response) return response

  if (!isCampaignContentEditable(campaign.status)) {
    return conflict(campaignLockedReason(campaign.status), campaign.status)
  }

  const validation = await validateBody(request, CampaignContentSchema)
  if (!validation.ok) return validation.response
  const refusal = audienceFilterRefusal(validation.data.audience_filter)
  if (refusal) return refusal

  const { data, error } = await db.from('campaigns')
    .update(contentPatch(validation.data))
    .eq('id', campaign.id)
    .in('status', [...EDITABLE_CAMPAIGN_STATUSES])
    .select('id, status, updated_at')
  if (error) {
    if (error.code === CHECK_VIOLATION) return conflict(campaignLockedReason(null), null)
    return serverError(error.message)
  }
  if (!data || data.length === 0) return conflict(STATUS_CHANGED, campaign.status)

  return NextResponse.json({ success: true, data: data[0] })
}

export async function DELETE(_request, props) {
  const { id } = await props.params
  const user = await getCurrentUser()
  const db = createServerClient()
  // The re-read CampaignEditor used to do from the browser (CAMPDEL.1): the
  // status held in React can be stale while the cron sends the campaign.
  const { campaign, response } = await loadCampaignForUser(db, user, id, 'id, location_id, status')
  if (response) return response

  if (!isCampaignContentEditable(campaign.status)) {
    const message = ['queued', 'sending'].includes(campaign.status)
      ? 'This campaign is sending. Cancel the send first, then delete.'
      : campaignUndeletableReason(campaign.status)
    return conflict(message, campaign.status)
  }

  const { data, error } = await db.from('campaigns')
    .delete()
    .eq('id', campaign.id)
    .in('status', [...EDITABLE_CAMPAIGN_STATUSES])
    .select('id')
  if (error) {
    if (error.code === CHECK_VIOLATION) return conflict(campaignUndeletableReason(null), null)
    return serverError(error.message)
  }
  if (!data || data.length === 0) return conflict(STATUS_CHANGED, campaign.status)

  return NextResponse.json({ success: true })
}
