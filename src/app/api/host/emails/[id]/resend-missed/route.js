// POST /api/host/emails/[id]/resend-missed — HOST-RESEND.1, host portal only.
//
// Send a SENT campaign again to the contacts who never received it: every
// contact the recipient resolver returns now who has no 'sent' row on the
// campaign (never queued at the time, or a failed row). Anyone with a sent
// row is never emailed twice. Thin wrapper over launchHostCampaign with
// trigger 'resend_missed' (src/lib/host-campaign-launch.js), so the sender,
// stream and daily-cap gates are the Send now ones, the sent→sending CAS is
// the double-click lock, and the queue drains it exactly like a first send.
// The finaliser keeps the first sent_at and stamps resent_at (mig 593).
//
// Responses: 200 { queued } · 401 no host session · 404 not this host's
// campaign · 409 not a sent campaign / sender unverified / no stream /
// daily cap / nobody missed ('Everyone who can be emailed already received
// this.') / already being resent · 500 db_error / resolve_failed /
// enqueue_failed.

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
  const result = await launchHostCampaign(db, { campaignId: params.id, hostId: session.host.id, trigger: 'resend_missed' })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: result.status })
  return NextResponse.json({ success: true, data: { queued: result.recipientCount } })
}
