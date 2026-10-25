// MEMBERWRITESWEEP.1e — POST /api/communications/campaigns/[id]/schedule:
// schedule a campaign for a future send (session auth, the campaign editor).
//
// Replaces the editor's browser-direct
// `update({ status: 'scheduled', scheduled_at, cancel_requested_at: null })`,
// which had no server check at all. A scheduled campaign is a send the
// run-campaigns cron promotes at scheduled_at, so this applies
// /api/campaigns/[id]/send's rules: the same statuses may be sent
// (draft | scheduled | failed) and the same subject/body guard (verbatim
// messages), under the same gate, email at the campaign's studio (D7).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import {
  loadCampaignForUser, CampaignScheduleSchema, conflict, serverError, STATUS_CHANGED, currentStatus,
} from '@/lib/campaign-session-access'

export const dynamic = 'force-dynamic'

const SCHEDULABLE = ['draft', 'scheduled', 'failed']
const badRequest = (error) => NextResponse.json({ success: false, error }, { status: 400 })

export async function POST(request, props) {
  const { id } = await props.params
  const user = await getCurrentUser()
  const db = createServerClient()
  const { campaign, response } = await loadCampaignForUser(db, user, id,
    'id, location_id, status, subject, html_content')
  if (response) return response

  const validation = await validateBody(request, CampaignScheduleSchema)
  if (!validation.ok) return validation.response
  const at = new Date(validation.data.scheduled_at)
  if (Number.isNaN(at.getTime())) return badRequest('That date and time could not be read. Pick it again.')
  if (at.getTime() <= Date.now()) return badRequest('Scheduled time must be in the future.')
  const scheduledAt = at.toISOString()

  if (!SCHEDULABLE.includes(campaign.status)) {
    return conflict(`Campaign is '${campaign.status}', cannot be scheduled`, campaign.status)
  }
  // COMMSFIX.D.2e — the send route's guard, verbatim: a campaign with no
  // subject or no body must never reach a send state.
  if (!campaign.subject || !String(campaign.subject).trim()) {
    return badRequest('This campaign has no subject — add one before sending.')
  }
  if (!campaign.html_content || !String(campaign.html_content).trim()) {
    return badRequest('This campaign has no email body — nothing was queued. Open it in the editor and add content.')
  }

  const { data, error } = await db.from('campaigns')
    .update({ status: 'scheduled', scheduled_at: scheduledAt, cancel_requested_at: null })
    .eq('id', campaign.id)
    .in('status', SCHEDULABLE)
    .select('id')
  if (error) return serverError(error.message)
  if (!data || data.length === 0) return conflict(STATUS_CHANGED, await currentStatus(db, campaign.id, campaign.status))

  return NextResponse.json({ success: true, data: { status: 'scheduled', scheduled_at: scheduledAt } })
}
