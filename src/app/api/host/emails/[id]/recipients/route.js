// GET /api/host/emails/[id]/recipients — HOST-METRICS.1, the report page's data:
// the campaign with its stats (host_campaign_stats(), mig 590) and every send
// row with its DERIVED outcome (host-campaign-outcome.js). Tenancy:
// getCurrentHost() + .eq('host_id') on the campaign → 404, no enumeration.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostCampaignStats, ZERO_STATS } from '@/lib/host-campaign-stats'
import { deriveOutcome, outcomeAt, failureCopy } from '@/lib/host-campaign-outcome'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 1k-row cap discipline: page explicitly rather than trusting a default limit.
const PAGE = 1000
// Hard ceiling on the pagination loop — a runaway/misbehaving query can never
// spin past this many rows.
const MAX_ROWS = 20000

// postmark_message_id is never read here — provider ids stay server-side.
const SEND_COLUMNS =
  'id, contact_id, email, status, claimed_at, sent_at, ' +
  'delivered_at, opened_at, open_count, clicked_at, click_count, bounced_at, ' +
  'bounce_type, complained_at, unsubscribed_at, failed_reason, ' +
  'contact:contacts!contact_id ( name, first_name, last_name )'

function recipientName(contact) {
  const c = contact || {}
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || c.name || ''
}

export async function GET(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: campaign, error: campaignErr } = await db
    .from('host_campaigns')
    .select('id, subject, status, email_type, audience_kind, audience_event_id, sent_at, created_at, recipient_count, sent_count')
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .maybeSingle()
  if (campaignErr) return NextResponse.json({ success: false, error: campaignErr.message }, { status: 500 })
  if (!campaign) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // Stats are NULL (not zeros) when the rpc fails: the page then says
  // "counts unavailable" instead of rendering confident zeros beside a full
  // recipient list (the unknown-count-never-renders-0 rule).
  const { byCampaign, error: statsErr } = await loadHostCampaignStats(db, session.host.id)
  const stats = statsErr ? null : (byCampaign.get(campaign.id) || ZERO_STATS)

  const recipients = []
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data: page, error } = await db
      .from('host_campaign_sends')
      .select(SEND_COLUMNS)
      .eq('campaign_id', campaign.id)
      .order('sent_at', { ascending: false, nullsFirst: false })
      .order('email', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

    for (const row of page || []) {
      const outcome = deriveOutcome(row)
      recipients.push({
        contact_id: row.contact_id,
        name: recipientName(row.contact),
        email: row.email,
        outcome,
        outcome_at: outcomeAt(row),
        failure_copy: outcome === 'failed' ? failureCopy(row.failed_reason) : null,
        sent_at: row.sent_at,
        delivered_at: row.delivered_at,
        opened_at: row.opened_at,
        open_count: row.open_count,
        clicked_at: row.clicked_at,
        click_count: row.click_count,
        bounced_at: row.bounced_at,
        bounce_type: row.bounce_type,
        complained_at: row.complained_at,
        unsubscribed_at: row.unsubscribed_at,
        failed_reason: row.failed_reason,
      })
    }
    if (!page || page.length < PAGE) break
  }

  return NextResponse.json({ success: true, data: { campaign: { ...campaign, stats }, recipients } })
}
