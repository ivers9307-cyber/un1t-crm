// GET  /api/host/emails — the host's OWN campaigns (HOST-EMAIL.3), newest first.
// POST /api/host/emails — create a DRAFT campaign. No sending here: the send
// gate (verified sender, daily cap, recipient resolution, CAS draft→sending)
// lives in /api/host/emails/[id]/send, and the fan-out runs on the cron.
// Tenancy: getCurrentHost() → every query .eq('host_id', session.host.id).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { designJsonTooBig, assertAudienceEventOwned } from '@/lib/host-campaign-draft'
import { loadHostCampaignStats, ZERO_STATS } from '@/lib/host-campaign-stats'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// HOST-EMAIL.4 — body cap raised for visual-composer exports (a full Unlayer
// html document); design_json is the editable design (round-trips into the
// composer), audience_event_id restricts recipients to one event's confirmed
// attendees (validated below: the event must belong to THIS host).
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CampaignDraftSchema = z.object({
  subject: z.string().min(1, 'Subject is required').max(200, 'Subject is too long (max 200 characters)'),
  body: z.string().min(1, 'Body is required').max(300000, 'Body is too long'),
  design_json: z.unknown().optional().nullable(),
  audience_event_id: z.string().regex(UUIDISH).optional().nullable(),
  audience_kind: z.enum(['all', 'event', 'mailing_list']).optional(),
  email_type: z.enum(['marketing', 'utility']).optional(),
})



export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data, error } = await db
    .from('host_campaigns')
    .select('id, subject, status, audience_kind, audience_event_id, email_type, recipient_count, sent_count, created_at, sent_at')
    .eq('host_id', session.host.id)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // HOST-METRICS.1 — per-campaign send stats (host_campaign_stats(), mig
  // 590). A stats hiccup never fails the list: on an rpc error the `stats`
  // key is OMITTED entirely (not zeroed) so the UI's own fallback renders
  // — a zeroed stats object would print "0 sent" for a campaign that
  // genuinely sent mail. A campaign missing from the rpc result still
  // gets ZERO_STATS (it really has none).
  const { byCampaign, error: statsErr } = await loadHostCampaignStats(db, session.host.id)
  const campaigns = statsErr
    ? (data || [])
    : (data || []).map((campaign) => ({
        ...campaign,
        stats: byCampaign.get(campaign.id) ?? ZERO_STATS,
      }))
  return NextResponse.json({ success: true, data: campaigns })
}

export async function POST(request) {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = CampaignDraftSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid email', issues: parsed.error.issues }, { status: 400 })
  }

  const db = createServerClient()
  if (designJsonTooBig(parsed.data.design_json)) {
    return NextResponse.json({ success: false, error: 'Design is too large.' }, { status: 400 })
  }
  // audience_kind defaults from the legacy field: an audience_event_id
  // implies 'event'; otherwise 'all'. kind='event' REQUIRES the event id;
  // the other kinds null it out.
  const kind = parsed.data.audience_kind || (parsed.data.audience_event_id ? 'event' : 'all')
  const audienceEventId = kind === 'event' ? parsed.data.audience_event_id || null : null
  if (kind === 'event' && !audienceEventId) {
    return NextResponse.json({ success: false, error: 'Pick an event for a per-event audience.' }, { status: 400 })
  }
  if (audienceEventId) {
    const audienceErr = await assertAudienceEventOwned(db, session.host.id, audienceEventId)
    if (audienceErr) return NextResponse.json({ success: false, error: audienceErr }, { status: 404 })
  }
  const { data: campaign, error } = await db
    .from('host_campaigns')
    .insert({
      design_json: parsed.data.design_json ?? null,
      audience_kind: kind,
      audience_event_id: audienceEventId,
      email_type: parsed.data.email_type === 'utility' ? 'utility' : 'marketing',
      host_id: session.host.id,
      subject: parsed.data.subject,
      body_html: parsed.data.body,
      status: 'draft',
    })
    .select('id, subject, status, audience_kind, audience_event_id, email_type, recipient_count, sent_count, created_at, sent_at')
    .single()
  if (error || !campaign) {
    return NextResponse.json({ success: false, error: error?.message || 'Create failed' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: campaign })
}
