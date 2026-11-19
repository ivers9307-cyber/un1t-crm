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
// Both rules and the write are src/lib/campaign-release.js (MCPEMAIL.1).
// SCHEDPREFLIGHT.1 — scheduling now also runs the send route's org email cap
// and prepaid-wallet checks (releasePreflight), answered the same way (422
// with the code). They were skipped here, so a scheduled campaign could pass
// a wallet that sending now would have refused; the run-campaigns cron's own
// cap check at send time stays as the second net.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { loadCampaignForUser, CampaignScheduleSchema, conflict, serverError } from '@/lib/campaign-session-access'
import { releasePreflight, releaseCampaign } from '@/lib/campaign-release'

export const dynamic = 'force-dynamic'

const badRequest = (error) => NextResponse.json({ success: false, error }, { status: 400 })
// The send route's two refusals that are not about the campaign itself.
const PREFLIGHT_422 = ['email_hard_cap', 'wallet_empty']

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

  // The status rule, the send route's subject/body guard (COMMSFIX.D.2e: a
  // campaign with no subject or no body must never reach a send state), then
  // the org email cap and the wallet. One copy in src/lib/campaign-release.js;
  // only the status refusal is worded for scheduling here.
  const check = await releasePreflight(db, campaign)
  if (!check.ok) {
    if (check.code === 'status') {
      return conflict(`Campaign is '${campaign.status}', cannot be scheduled`, campaign.status)
    }
    if (PREFLIGHT_422.includes(check.code)) {
      return NextResponse.json({ success: false, error: check.message, code: check.code }, { status: 422 })
    }
    return badRequest(check.message)
  }

  const release = await releaseCampaign(db, campaign, { sendAt: at })
  if (!release.ok) {
    if (release.code === 'conflict') return conflict(release.message, release.current_status)
    return serverError(release.message)
  }

  return NextResponse.json({ success: true, data: { status: release.status, scheduled_at: release.scheduled_at } })
}
