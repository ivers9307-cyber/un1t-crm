// POST /api/host/emails/[id]/send — queue a draft campaign for sending
// (HOST-EMAIL.3). Gates, in order:
//
//   1. getCurrentHost() + own campaign (.eq('host_id')) → 404 (no enumeration).
//   2. sender_domain_verified (the UN1T kill switch) → 409 with guidance.
//   2b. postmark_stream_id for a marketing send (HOST-CONSENT.1) → 409.
//   3. Daily campaign cap — campaigns already sending/sent today (UTC) vs
//      event_hosts.email_daily_send_cap → 409.
//   4. Recipients resolved AT SEND TIME (consent + per-host suppression);
//      0 emailable → 409.
//   5. CAS draft→sending (.eq('status','draft') — 0 rows = a concurrent send
//      already claimed it) → 409. recipient_count stamps in the same update.
//
// Then the fan-out is ENQUEUED — chunked insert into host_campaign_sends
// (pending) — and drained by the QStash host-campaigns worker (kicked
// below, QSTASH.8) with /api/cron/send-host-campaigns as the sweeper,
// never the request thread. The UNIQUE(campaign_id, contact_id) pair +
// ignoreDuplicates makes the enqueue idempotent if this request retries
// after a partial insert.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { resolveHostRecipients } from '@/lib/host-campaign-email'
import { publishQueuePush, HOST_CAMPAIGNS_WORKER_PATH } from '@/lib/qstash'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ENQUEUE_CHUNK = 500 // rows per host_campaign_sends insert statement

export async function POST(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()

  // Own campaign or 404 — the .eq('host_id') is the tenancy boundary.
  const { data: campaign } = await db
    .from('host_campaigns')
    .select('id, status, audience_kind, audience_event_id, email_type')
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .maybeSingle()
  if (!campaign) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // Sender identity — HOST_PORTAL_COLS deliberately excludes the sender
  // columns, so load them here. Missing sender_email with verified=true is a
  // provisioning inconsistency; treat it as not-enabled rather than sending
  // from a broken From header.
  const { data: host } = await db
    .from('event_hosts')
    .select('id, sender_domain_verified, sender_email, sender_name, email_daily_send_cap, postmark_stream_id')
    .eq('id', session.host.id)
    .maybeSingle()
  if (!host) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!host.sender_domain_verified || !host.sender_email) {
    return NextResponse.json(
      { success: false, error: 'Sending is not enabled — ask UN1T to verify your sending domain.' },
      { status: 409 },
    )
  }

  // HOST-CONSENT.1 — marketing needs the host's own Postmark stream.
  if (campaign.email_type !== 'utility' && !host.postmark_stream_id) {
    return NextResponse.json(
      { success: false, error: 'Marketing sending is not set up for this host yet — ask UN1T to attach your Postmark stream.' },
      { status: 409 },
    )
  }

  // Daily cap: campaigns this host has put into flight today (UTC midnight —
  // matches the cap's plain reading, no BST wobble on the boundary).
  const now = new Date()
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
  const { count: sentToday, error: capErr } = await db
    .from('host_campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('host_id', session.host.id)
    .in('status', ['sending', 'sent'])
    .gte('created_at', utcMidnight)
  if (capErr) return NextResponse.json({ success: false, error: capErr.message }, { status: 500 })
  const cap = host.email_daily_send_cap ?? 2
  if ((sentToday || 0) >= cap) {
    return NextResponse.json({ success: false, error: 'Daily send limit reached.' }, { status: 409 })
  }

  // Recipients resolve at send time — consent + per-host suppression + dedupe.
  let recipients
  try {
    // HOST-EMAIL.4 — per-event audience: resolved from confirmed
    // registrations at send time when the draft targets one event.
    // HOST-GROWTH.11 — audience_kind picks the population: 'event' →
    // that event's confirmed attendees; 'mailing_list' → contacts with
    // source='mailing_list'; 'all' → the whole list.
    // Legacy-row guard: rows written by pre-audience_kind code carry the
    // column default 'all' WITH an audience_event_id set (mig 460's one-shot
    // backfill can't cover rows created after it ran). An event id on a
    // non-mailing_list row therefore always means a per-event audience —
    // the pre-460 semantic. New-code rows null the id for non-event kinds,
    // so this fallback can only fire on legacy rows.
    const audienceEventId = campaign.audience_kind !== 'mailing_list' ? campaign.audience_event_id || null : null
    recipients = await resolveHostRecipients(db, session.host.id, {
      audienceEventId,
      mailingListOnly: campaign.audience_kind === 'mailing_list',
      emailType: campaign.email_type === 'utility' ? 'utility' : 'marketing',
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
  if (recipients.length === 0) {
    return NextResponse.json({ success: false, error: 'No emailable contacts.' }, { status: 409 })
  }

  // CAS draft→sending — the double-send guard. A concurrent request (or a
  // non-draft campaign) matches 0 rows and 409s; exactly one wins.
  const { data: claimed, error: casErr } = await db
    .from('host_campaigns')
    .update({ status: 'sending', recipient_count: recipients.length })
    .eq('id', campaign.id)
    .eq('status', 'draft')
    .select('id')
  if (casErr) return NextResponse.json({ success: false, error: casErr.message }, { status: 500 })
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ success: false, error: 'This email has already been sent.' }, { status: 409 })
  }

  // Enqueue the fan-out. ignoreDuplicates on UNIQUE(campaign_id, contact_id)
  // keeps a retried enqueue idempotent.
  const rows = recipients.map((r) => ({
    campaign_id: campaign.id,
    contact_id: r.contact_id,
    email: r.email,
    status: 'pending',
  }))
  for (let i = 0; i < rows.length; i += ENQUEUE_CHUNK) {
    const chunk = rows.slice(i, i + ENQUEUE_CHUNK)
    const { error } = await db
      .from('host_campaign_sends')
      .upsert(chunk, { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true })
    if (error) {
      // Partial enqueue: the campaign is 'sending' and the cron will drain
      // whatever landed; surface the error so the host/operator knows.
      return NextResponse.json({ success: false, error: `Queueing failed: ${error.message}` }, { status: 500 })
    }
  }

  // QSTASH.8 — kick the QStash worker so the first chunk goes out in
  // ~seconds instead of waiting for the next cron tick. ONE campaign-level
  // message — the worker self-chains one ≤50-row chunk at a time (a
  // per-recipient publish would burn the QStash request budget and lose
  // pacing). Ordering is load-bearing: published only AFTER every fan-out
  // chunk landed — a kick delivered before the pending rows exist would
  // look "drained" to the worker and mis-finalise the campaign (the
  // partial-enqueue 500 above deliberately publishes nothing; the sweeper
  // cron drains whatever landed). Fire-and-forget: env-gated inside
  // publishQueuePush, never throws, own try/catch — a QStash outage
  // degrades to cron-cadence delivery, never a failed send request.
  // Dedup id is DASH-ONLY (QStash 400s on colons — the QSTASH.2 lesson).
  try {
    await publishQueuePush({
      path: HOST_CAMPAIGNS_WORKER_PATH,
      body: { campaignId: campaign.id },
      deduplicationId: `host-campaign-${campaign.id}-kick`,
    })
  } catch {
    // publishQueuePush swallows its own errors; belt-and-braces only.
  }

  return NextResponse.json({ success: true, data: { recipient_count: recipients.length } })
}
