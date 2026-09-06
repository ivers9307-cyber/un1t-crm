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
//
// HOST-SCHEDULE.1 — the cron ALSO fires scheduled campaigns: at the top of
// every tick it picks ≤10 rows with status='scheduled' and scheduled_for
// <= now() (idx_host_campaigns_due, mig 592) and calls launchHostCampaign
// with trigger 'schedule' — the SAME gates and enqueue as Send now; the
// CAS scheduled→sending inside it is the lock, so two overlapping ticks
// launch once. Runs BEFORE the 'sending' pass so a just-launched campaign
// gets its first chunk in this tick (the QStash kick also fires).
// Refusal mapping (launchDueCampaigns):
//   - a gate reason (LAUNCH_GATE_REASONS: sender_not_verified, no_stream,
//     daily_cap, no_recipients) OR a thrown launch (a code bug, mapped to
//     'launch_failed' — must not retry forever silently) → CAS the row
//     scheduled→draft with scheduled_for: null and schedule_error set to
//     the reason; pushed to summary.refused.
//   - db_error / resolve_failed (transient, pre-CAS) → the row is left
//     'scheduled' for the next tick to retry; pushed to summary.errors,
//     no update statement.
//   - enqueue_failed (post-CAS — the row is already 'sending') → left as
//     is, the sending pass below drains what landed; pushed to
//     summary.errors, no update statement.
//   - cas_lost / not_found → silent skip: another sweep won the CAS, or
//     the row vanished between the due pick and the launch.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { processHostCampaignChunk } from '@/lib/host-campaign-queue'
import { launchHostCampaign, LAUNCH_GATE_REASONS } from '@/lib/host-campaign-launch'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_CAMPAIGNS_PER_TICK = 5
const CLAIM_STALE_MS = 15 * 60_000  // claimed-but-unresolved rows older than this → failed
const MAX_DUE_PER_TICK = 10
// Reasons that leave the campaign untouched (pre-CAS gate refusals) — a
// thrown launch is folded into this same back-to-draft path as 'launch_failed'.
const SCHEDULE_GATE_REASONS = new Set(LAUNCH_GATE_REASONS)

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
  const summary = { launched: 0, refused: [], campaigns: 0, sent: 0, failed: 0, finalised: 0, errors: [] }

  await launchDueCampaigns(db, summary)

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

// HOST-SCHEDULE.1 — fire due scheduled campaigns (see header for the
// refusal mapping). Never throws: every failure lands in summary.refused
// or summary.errors and the sending pass + heartbeat still run.
async function launchDueCampaigns(db, summary) {
  const { data: due, error: dueErr } = await db
    .from('host_campaigns')
    .select('id, host_id')
    .eq('status', 'scheduled')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(MAX_DUE_PER_TICK)
  if (dueErr) {
    logError('host-campaigns', 'due pick failed', { error: dueErr.message })
    summary.errors.push({ stage: 'due_pick', error: dueErr.message })
    return
  }

  for (const c of due || []) {
    let result
    try {
      result = await launchHostCampaign(db, { campaignId: c.id, hostId: c.host_id, trigger: 'schedule' })
    } catch (err) {
      result = { ok: false, reason: 'launch_failed', error: err?.message || String(err) }
    }
    if (result.ok) {
      summary.launched += 1
      logInfo('host-campaigns', 'scheduled campaign launched', { campaign_id: c.id, recipient_count: result.recipientCount })
      continue
    }

    // cas_lost: another sweep won the race. not_found: the row vanished
    // between the due pick and the launch. Either way — silent skip.
    if (result.reason === 'cas_lost' || result.reason === 'not_found') continue

    // enqueue_failed is post-CAS — the campaign is already 'sending' and
    // the sending pass below drains whatever landed. db_error /
    // resolve_failed are transient pre-CAS reads — leave the row
    // 'scheduled' so the next tick retries. Neither gets an update
    // statement; both are deferred into summary.errors.
    if (result.reason === 'enqueue_failed' || result.reason === 'db_error' || result.reason === 'resolve_failed') {
      summary.errors.push({ campaign_id: c.id, error: result.error })
      logError('host-campaigns', 'scheduled launch deferred', { campaign_id: c.id, reason: result.reason, error: result.error })
      continue
    }

    // A gate refusal, or a thrown launch collapsed to 'launch_failed' —
    // CAS the row back to draft with the reason so the host can see why
    // and retry manually. A code bug must not retry forever silently.
    const code = SCHEDULE_GATE_REASONS.has(result.reason) ? result.reason : 'launch_failed'
    const { error: backErr } = await db
      .from('host_campaigns')
      .update({ status: 'draft', scheduled_for: null, schedule_error: code })
      .eq('id', c.id)
      .eq('status', 'scheduled')
    if (backErr) {
      summary.errors.push({ campaign_id: c.id, error: backErr.message })
      logError('host-campaigns', 'scheduled refusal write failed', { campaign_id: c.id, error: backErr.message })
    }
    summary.refused.push({ campaign_id: c.id, reason: code })
    logError('host-campaigns', 'scheduled launch refused', { campaign_id: c.id, reason: code, error: result.error })
  }
}
