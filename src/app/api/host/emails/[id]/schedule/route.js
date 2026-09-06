// POST /api/host/emails/[id]/schedule — HOST-SCHEDULE.1.
//
// Body { scheduled_for: ISO }. Marks a draft (or an already scheduled
// campaign: reschedule is the same call) as 'scheduled' for that UTC
// instant; the sweeper cron (/api/cron/send-host-campaigns) launches it
// through launchHostCampaign when it comes due. Gates:
//
//   1. getCurrentHost() + own campaign (.eq('host_id')) → 404 (no enumeration).
//   2. window — validateScheduledFor: ≥15 min ahead, ≤90 days → 400.
//   3. status must be draft|scheduled → 409 (a sending/sent campaign cannot
//      be scheduled; the same message the send route uses).
//   4. Early feedback ONLY: sender verified, stream for marketing → 409 with
//      the send route's wording. The daily cap and the recipient list are
//      NOT checked here — both can change before fire time and are
//      re-evaluated by the launch; a refusal then lands in schedule_error.
//   5. CAS status in (draft, scheduled) → scheduled, clearing schedule_error.
//
// PATCH /api/host/emails/[id] stays CAS'd on 'draft', so a scheduled body
// cannot be edited under a pending fire (the composer unschedules first).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { validateScheduledFor } from '@/lib/host-schedule-time'
import { LAUNCH_MESSAGES } from '@/lib/host-campaign-launch'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({ scheduled_for: z.string().min(1) })

const CAMPAIGN_COLUMNS = 'id, subject, status, audience_kind, audience_event_id, email_type, recipient_count, sent_count, created_at, sent_at, scheduled_for, schedule_error'

export async function POST(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = Body.safeParse(body)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Pick a date and time.' }, { status: 400 })
  const when = validateScheduledFor(parsed.data.scheduled_for)
  if (!when.ok) return NextResponse.json({ success: false, error: when.error }, { status: 400 })

  const db = createServerClient()

  const { data: campaign } = await db
    .from('host_campaigns')
    .select('id, status, email_type')
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .maybeSingle()
  if (!campaign) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
    return NextResponse.json({ success: false, error: LAUNCH_MESSAGES.cas_lost }, { status: 409 })
  }

  const { data: host } = await db
    .from('event_hosts')
    .select('id, sender_domain_verified, sender_email, postmark_stream_id')
    .eq('id', session.host.id)
    .maybeSingle()
  if (!host) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!host.sender_domain_verified || !host.sender_email) {
    return NextResponse.json({ success: false, error: LAUNCH_MESSAGES.sender_not_verified }, { status: 409 })
  }
  if (campaign.email_type !== 'utility' && !host.postmark_stream_id) {
    return NextResponse.json({ success: false, error: LAUNCH_MESSAGES.no_stream }, { status: 409 })
  }

  // CAS on draft|scheduled — a fire or a send that landed between the read
  // and this write matches 0 rows → 409, never a silent overwrite.
  const { data: rows, error } = await db
    .from('host_campaigns')
    .update({ status: 'scheduled', scheduled_for: when.iso, schedule_error: null })
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .in('status', ['draft', 'scheduled'])
    .select(CAMPAIGN_COLUMNS)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!rows || rows.length === 0) {
    return NextResponse.json({ success: false, error: LAUNCH_MESSAGES.cas_lost }, { status: 409 })
  }
  return NextResponse.json({ success: true, data: rows[0] })
}
