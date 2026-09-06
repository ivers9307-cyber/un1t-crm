// HOST-EMAIL.3 — host campaign send cron (every 2 minutes, vercel.json).
// QSTASH.8: now the SWEEPER — the QStash host-campaigns worker
// (/api/webhooks/qstash/host-campaigns, kicked by the send route and
// self-chained one chunk at a time) is the primary consumer; this cron
// guarantees delivery when QStash is unconfigured, a kick/chain publish
// fails, a chain link crashes, the MAX_CHAIN lineage cap is hit, or a
// halted (kill-switch) campaign is re-verified and must resume.
//
// The per-campaign chunk logic lives in src/lib/host-campaign-queue.js
// (processHostCampaignChunk) — the SAME claim-before-send CAS for both
// consumers: pending→claimed conditioned on status still 'pending', so
// an overlapping worker/cron pair claims disjoint rows and can never
// double-send. Per tick: ≤5 'sending' campaigns oldest-first, one
// ≤50-row chunk each.
//
// CRON-ONLY responsibilities (the worker deliberately has none of these):
//   - Stale-claim sweep: claimed rows a crashed consumer left behind go
//     terminal 'failed' after CLAIM_STALE_MS. host_campaign_sends has no
//     attempts column, so terminal-fail is the safe choice: it can never
//     double-send and can never loop; the trade is that a crashed
//     consumer's batch (≤50 rows) is not retried. sent_count/
//     recipient_count expose the gap to the host. Swept BEFORE the chunk
//     call so an otherwise-drained campaign finalises in the same tick.
//   - The ≤5-campaigns-per-tick outer loop and run summary.
//   - The heartbeat — stamps at the end of every run; a failed campaign
//     chunk lands in `errors` and never blocks the others.
//
// Safety posture (unchanged, now enforced inside the shared lib): the
// host's sender_domain_verified is re-checked EVERY chunk — the UN1T
// kill switch stops an in-flight campaign, not just new ones; unverified
// campaigns stay 'sending' ('halted', resume here if re-verified) rather
// than failing.
//
// HOST-METRICS.1 — the stale-claim sweep stamps failed_reason: 'stale_claim'
// so the host can tell a crashed-consumer row apart from a gate refusal.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { processHostCampaignChunk } from '@/lib/host-campaign-queue'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_CAMPAIGNS_PER_TICK = 5
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
    .select('id, host_id, status')
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
      await sweepStaleClaims(db, campaign.id)
      const result = await processHostCampaignChunk(db, campaign.id)
      if (result.status === 'failed') {
        summary.errors.push({ campaign_id: campaign.id, error: result.error })
        logError('host-campaigns', 'campaign tick threw', { campaign_id: campaign.id, error: result.error })
        continue
      }
      summary.campaigns += 1
      summary.sent += result.sent || 0
      summary.failed += result.failed || 0
      if (result.status === 'drained') summary.finalised += 1
    } catch (err) {
      // Belt-and-braces — the lib returns 'failed' rather than throwing.
      const msg = err?.message || String(err)
      summary.errors.push({ campaign_id: campaign.id, error: msg })
      logError('host-campaigns', 'campaign tick threw', { campaign_id: campaign.id, error: msg })
    }
  }

  await stampHeartbeat('send-host-campaigns')
  return NextResponse.json({ ok: true, ...summary })
}

// Sweep stale claims (see header) so a crashed consumer — cron tick OR
// QStash chain link — can't block finalisation. Runs regardless of the
// campaign's verify state (a stale claim is crash debris either way and
// can never be sent — only 'pending' rows are claimable).
async function sweepStaleClaims(db, campaignId) {
  const staleCutoff = new Date(Date.now() - CLAIM_STALE_MS).toISOString()
  const { data: swept } = await db
    .from('host_campaign_sends')
    .update({ status: 'failed', failed_reason: 'stale_claim' })
    .eq('campaign_id', campaignId)
    .eq('status', 'claimed')
    .lt('claimed_at', staleCutoff)
    .select('id')
  if (swept?.length) {
    logError('host-campaigns', 'stale claimed rows swept to failed', {
      campaign_id: campaignId, count: swept.length,
    })
  }
}
