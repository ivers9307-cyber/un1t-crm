// POST /api/host/emails/[id]/send — queue a draft campaign for sending
// (HOST-EMAIL.3). Since HOST-SCHEDULE.1 this is a thin wrapper over
// launchHostCampaign (src/lib/host-campaign-launch.js), which owns every
// gate, the draft→sending CAS, the chunked enqueue and the QStash kick, so
// Send now and a scheduled fire can never drift apart. The refusal reasons
// map 1:1 onto the statuses this route has always answered with:
//   not_found 404 · sender_not_verified / no_stream / daily_cap /
//   no_recipients / cas_lost 409 · db_error / resolve_failed /
//   enqueue_failed 500.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { launchHostCampaign } from '@/lib/host-campaign-launch'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const result = await launchHostCampaign(db, { campaignId: params.id, hostId: session.host.id, trigger: 'send_now' })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: result.status })
  return NextResponse.json({ success: true, data: { recipient_count: result.recipientCount } })
}
