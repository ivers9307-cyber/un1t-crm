// HOST-EMAIL.3 — host campaign send cron (every 2 minutes, vercel.json).
//
// Drains host_campaign_sends with the claim-before-send pattern
// (campaign-sender.js is the model): for each 'sending' campaign (oldest
// first, ≤5 per tick), CAS-claim ≤50 pending rows (pending→claimed,
// .select() returns only the rows THIS tick won — an overlapping invocation
// matches 0 of the same ids), send each via the Postmark BROADCAST stream
// from the host's verified sender, mark sent/failed per row, then refresh the
// campaign's sent_count and finalise (status 'sent' / 'failed') once nothing
// is pending or claimed.
//
// Safety posture:
//   - The host's sender_domain_verified is re-checked EVERY tick — the UN1T
//     kill switch stops an in-flight campaign, not just new ones. Unverified
//     campaigns stay 'sending' (resume if re-verified) rather than failing.
//   - Stale claims (a tick that died between claim and result) are swept to
//     'failed' after CLAIM_STALE_MS. host_campaign_sends has no attempts
//     column, so terminal-fail is the safe choice: it can never double-send
//     and can never loop; the trade is that a crashed tick's batch (≤50 rows)
//     is not retried. sent_count/recipient_count expose the gap to the host.
//   - Per-row errors are logged and the row marked failed; the cron itself
//     never throws — the heartbeat stamps at the end of every run.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { renderHostCampaignHtml } from '@/lib/host-campaign-email'
import { signHostUnsubToken } from '@/lib/host-unsubscribe'
import { sendEmail } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_CAMPAIGNS_PER_TICK = 5
const BATCH_SIZE = 50               // send rows claimed per campaign per tick
const CLAIM_STALE_MS = 15 * 60_000  // claimed-but-unresolved rows older than this → failed

function unauthorized() {
  return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
}

export async function GET(request) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error('[cron send-host-campaigns] CRON_SECRET is not set')
    return NextResponse.json({ ok: false, error: 'cron_secret_missing' }, { status: 500 })
  }
  const got = request.headers.get('authorization') || ''
  if (got !== `Bearer ${expected}`) return unauthorized()

  const db = createServerClient()
  const summary = { campaigns: 0, sent: 0, failed: 0, finalised: 0, errors: [] }

  const { data: campaigns, error: pickErr } = await db
    .from('host_campaigns')
    .select('id, host_id, subject, body_html, status, recipient_count, sent_count')
    .eq('status', 'sending')
    .order('created_at', { ascending: true })
    .limit(MAX_CAMPAIGNS_PER_TICK)
  if (pickErr) {
    logError('host-campaigns', 'campaign pick failed', { error: pickErr.message })
    await stampHeartbeat('send-host-campaigns')
    return NextResponse.json({ ok: false, ...summary, error: pickErr.message }, { status: 500 })
  }

  for (const campaign of campaigns || []) {
    try {
      const result = await tickHostCampaign(db, campaign)
      summary.campaigns += 1
      summary.sent += result.sent
      summary.failed += result.failed
      if (result.finalised) summary.finalised += 1
    } catch (err) {
      const msg = err?.message || String(err)
      summary.errors.push({ campaign_id: campaign.id, error: msg })
      logError('host-campaigns', 'campaign tick threw', { campaign_id: campaign.id, error: msg })
    }
  }

  await stampHeartbeat('send-host-campaigns')
  return NextResponse.json({ ok: true, ...summary })
}

async function tickHostCampaign(db, campaign) {
  const result = { sent: 0, failed: 0, finalised: false }

  // Sender identity + kill switch — re-checked every tick.
  const { data: host, error: hostErr } = await db
    .from('event_hosts')
    .select('id, name, email, sender_email, sender_name, sender_domain_verified')
    .eq('id', campaign.host_id)
    .maybeSingle()
  if (hostErr) throw new Error(`host load failed: ${hostErr.message}`)
  if (!host) {
    // Orphaned campaign (host row gone) — terminal.
    await db.from('host_campaigns').update({ status: 'failed' }).eq('id', campaign.id).eq('status', 'sending')
    logError('host-campaigns', 'campaign host missing — marked failed', { campaign_id: campaign.id })
    return result
  }
  if (!host.sender_domain_verified || !host.sender_email) {
    // Kill switch: leave the campaign 'sending' but send nothing. It resumes
    // if UN1T re-verifies the domain.
    logError('host-campaigns', 'sender not verified — campaign paused', {
      campaign_id: campaign.id, host_id: host.id,
    })
    return result
  }

  // Sweep stale claims (see header) so a crashed tick can't block finalisation.
  const staleCutoff = new Date(Date.now() - CLAIM_STALE_MS).toISOString()
  const { data: swept } = await db
    .from('host_campaign_sends')
    .update({ status: 'failed' })
    .eq('campaign_id', campaign.id)
    .eq('status', 'claimed')
    .lt('claimed_at', staleCutoff)
    .select('id')
  if (swept?.length) {
    logError('host-campaigns', 'stale claimed rows swept to failed', {
      campaign_id: campaign.id, count: swept.length,
    })
  }

  // Claim a batch: select candidate ids, then CAS pending→claimed. Only the
  // rows the update RETURNS are ours — a concurrent tick claims disjoint rows.
  const { data: candidates, error: candErr } = await db
    .from('host_campaign_sends')
    .select('id')
    .eq('campaign_id', campaign.id)
    .eq('status', 'pending')
    .order('id', { ascending: true })
    .limit(BATCH_SIZE)
  if (candErr) throw new Error(`pending fetch failed: ${candErr.message}`)

  let claimed = []
  if (candidates?.length) {
    const { data: rows, error: claimErr } = await db
      .from('host_campaign_sends')
      .update({ status: 'claimed', claimed_at: new Date().toISOString() })
      .in('id', candidates.map((r) => r.id))
      .eq('status', 'pending')
      .select('id, contact_id, email')
    if (claimErr) throw new Error(`claim failed: ${claimErr.message}`)
    claimed = rows || []
  }

  if (claimed.length > 0) {
    const baseUrl = getAppUrl()
    const senderName = host.sender_name || host.name || ''
    const from = `"${senderName.replace(/"/g, "'")}" <${host.sender_email}>`

    for (const row of claimed) {
      // Fresh per-contact unsubscribe token — the footer link is per-host,
      // per-contact (host_email_suppressions), injected by the renderer.
      const unsubscribeUrl =
        `${baseUrl}/unsubscribe/host/${signHostUnsubToken({ hostId: campaign.host_id, contactId: row.contact_id })}`
      const htmlBody = renderHostCampaignHtml({
        host,
        subject: campaign.subject,
        bodyHtml: campaign.body_html,
        unsubscribeUrl,
      })
      try {
        await sendEmail({
          to: row.email,
          from,
          replyTo: host.email || undefined,
          subject: campaign.subject,
          htmlBody,
          stream: 'broadcast',
          tag: 'host-campaign',
          metadata: { host_campaign_id: campaign.id, host_id: host.id, contact_id: row.contact_id },
        })
        result.sent += 1
        await db.from('host_campaign_sends')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', row.id)
      } catch (err) {
        result.failed += 1
        logError('host-campaigns', 'send failed', {
          campaign_id: campaign.id, send_id: row.id, error: err?.message || String(err),
        })
        await db.from('host_campaign_sends').update({ status: 'failed' }).eq('id', row.id)
      }
    }

    // One campaign update per batch. sent_count is RE-DERIVED from the queue
    // (not read-modify-write incremented) so overlapping ticks that processed
    // disjoint batches can't clobber each other's increment.
    const { count: sentTotal } = await db
      .from('host_campaign_sends')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('status', 'sent')
    await db.from('host_campaigns')
      .update({ sent_count: sentTotal || 0 })
      .eq('id', campaign.id)
  }

  // Finalise once nothing is pending AND nothing is claimed (in flight).
  const { count: pendingLeft } = await db
    .from('host_campaign_sends')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaign.id)
    .eq('status', 'pending')
  if ((pendingLeft || 0) === 0) {
    const { count: claimedLeft } = await db
      .from('host_campaign_sends')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('status', 'claimed')
    if ((claimedLeft || 0) === 0) {
      const { count: sentTotal } = await db
        .from('host_campaign_sends')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaign.id)
        .eq('status', 'sent')
      // Every row failed → 'failed'; anything delivered → 'sent'.
      const finalStatus = (sentTotal || 0) === 0 ? 'failed' : 'sent'
      await db.from('host_campaigns')
        .update({
          status: finalStatus,
          sent_count: sentTotal || 0,
          ...(finalStatus === 'sent' ? { sent_at: new Date().toISOString() } : {}),
        })
        .eq('id', campaign.id)
        .eq('status', 'sending')
      result.finalised = true
    }
  }

  return result
}
