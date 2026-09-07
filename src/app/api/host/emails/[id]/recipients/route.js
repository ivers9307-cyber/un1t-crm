// GET /api/host/emails/[id]/recipients — HOST-METRICS.1, the report page's data:
// the campaign with its stats (host_campaign_stats(), mig 590) and every send
// row with its DERIVED outcome (host-campaign-outcome.js). Tenancy:
// getCurrentHost() + .eq('host_id') on the campaign → 404, no enumeration.
//
// HOST-RESEND.1 — a SENT campaign also carries `missed_count`: how many
// contacts a "Resend to those who missed it" would reach right now, from the
// SAME helper the resend route enqueues with (resolveMissedRecipients), so
// the button's number and the send can't disagree. Null (never 0) when the
// helper fails, and null for any non-sent status; `resent_at` (mig 593)
// rides along for the header.
//
// HOST-EMAILS.2 — three more fields: `paused_reason` (a 'sending' campaign
// the queue has halted, from the same hostSendBlockReason predicate as the
// list route); `non_openers_count` (how many a "Send a reminder" draft
// would reach right now, from the same resolver the reminder-draft's send
// uses — null, never 0, on a resolver failure); and top-level `links`, one
// row per clicked URL from host_campaign_clicks (mig 594), aggregated with
// a per-person count and sorted clicks desc, the unsubscribe link last.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostCampaignStats, ZERO_STATS } from '@/lib/host-campaign-stats'
import { deriveOutcome, outcomeAt, failureCopy } from '@/lib/host-campaign-outcome'
import { resolveMissedRecipients, hostSendBlockReason } from '@/lib/host-campaign-launch'
import { resolveHostRecipients } from '@/lib/host-campaign-email'
import { logError } from '@/lib/log'

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
    .select('id, subject, status, email_type, audience_kind, audience_event_id, sent_at, resent_at, created_at, recipient_count, sent_count, scheduled_for')
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .maybeSingle()
  if (campaignErr) return NextResponse.json({ success: false, error: campaignErr.message }, { status: 500 })
  if (!campaign) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // HOST-EMAILS.2 — same host read + predicate as the list route, so a
  // 'sending' campaign the queue has halted shows PAUSED here too.
  const { data: hostRow, error: hostErr } = await db
    .from('event_hosts')
    .select('sender_domain_verified, sender_email, postmark_stream_id')
    .eq('id', session.host.id)
    .maybeSingle()
  if (hostErr) return NextResponse.json({ success: false, error: hostErr.message }, { status: 500 })
  const pausedReason = campaign.status === 'sending' ? hostSendBlockReason(hostRow, campaign) : null

  // Stats are NULL (not zeros) when the rpc fails: the page then says
  // "counts unavailable" instead of rendering confident zeros beside a full
  // recipient list (the unknown-count-never-renders-0 rule).
  const { byCampaign, error: statsErr } = await loadHostCampaignStats(db, session.host.id)
  const stats = statsErr ? null : (byCampaign.get(campaign.id) || ZERO_STATS)

  // Unknown never renders 0: a failed diff hides the count, not the button.
  let missedCount = null
  if (campaign.status === 'sent') {
    try {
      missedCount = (await resolveMissedRecipients(db, { hostId: session.host.id, campaign })).missed.length
    } catch (err) {
      logError('host-campaigns', 'missed-count diff failed', { campaign_id: campaign.id, error: err?.message || String(err) })
    }
  }

  // HOST-EMAILS.2 — how many a "Send a reminder" draft would reach right
  // now: delivered-but-never-opened-or-clicked on THIS campaign, from the
  // same resolver a reminder draft's send uses. Null (never 0) on failure.
  let nonOpenersCount = null
  if (campaign.status === 'sent') {
    try {
      const nonOpeners = await resolveHostRecipients(db, session.host.id, {
        nonOpenersOf: campaign.id,
        emailType: campaign.email_type === 'utility' ? 'utility' : 'marketing',
      })
      nonOpenersCount = nonOpeners.length
    } catch (err) {
      logError('host-campaigns', 'non-openers count failed', { campaign_id: campaign.id, error: err?.message || String(err) })
    }
  }

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

  // HOST-EMAILS.2 — one row per clicked URL from host_campaign_clicks (mig
  // 594), aggregated with a per-person count (contact_id, falling back to
  // send_id for a click with no matched contact). Sorted clicks desc, the
  // unsubscribe link always last regardless of its own click count.
  const clicksByUrl = new Map()
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data: page, error } = await db
      .from('host_campaign_clicks')
      .select('url, contact_id, send_id')
      .eq('campaign_id', campaign.id)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    for (const c of page || []) {
      const agg = clicksByUrl.get(c.url) || { url: c.url, clicks: 0, people: new Set(), is_unsubscribe: c.url.includes('/unsubscribe/host/') }
      agg.clicks += 1
      agg.people.add(c.contact_id || c.send_id)
      clicksByUrl.set(c.url, agg)
    }
    if (!page || page.length < PAGE) break
  }
  const links = [...clicksByUrl.values()]
    .map((l) => ({ url: l.url, clicks: l.clicks, people: l.people.size, is_unsubscribe: l.is_unsubscribe }))
    .sort((a, b) => (a.is_unsubscribe - b.is_unsubscribe) || (b.clicks - a.clicks) || a.url.localeCompare(b.url))

  return NextResponse.json({
    success: true,
    data: {
      campaign: { ...campaign, stats, missed_count: missedCount, paused_reason: pausedReason, non_openers_count: nonOpenersCount },
      recipients,
      links,
    },
  })
}
