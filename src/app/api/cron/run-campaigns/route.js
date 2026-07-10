// CAMPAIGN.13 — campaign send cron.
//
// Runs every minute. Two responsibilities:
//
//   1. Promote scheduled campaigns that have hit their send time:
//        UPDATE campaigns SET status='queued'
//        WHERE status='scheduled' AND scheduled_at <= now()
//
//   2. For each campaign currently 'queued' or 'sending',
//      delegate one tick to tickCampaignSend. That function
//      handles the populate-then-send state machine internally
//      and pages 500 recipients per tick — gentle on Postmark
//      AND on our deferred-webhook queue.
//
// Throughput math: 500 sent / 60s = ~8 emails/sec, ~8 webhooks/sec
// after Postmark fires. With the webhook handler now sub-50ms
// (queue insert only) and the webhook-processor cron draining
// independently, this stays under any Vercel concurrency limit
// the "15 mins?" send tripped.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { tickCampaignSend } from '@/lib/campaign-sender'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_CAMPAIGNS_PER_TICK = 3   // limit parallelism within one cron invocation

function unauthorized() {
  return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
}

export async function GET(request) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error('[cron run-campaigns] CRON_SECRET is not set')
    return NextResponse.json({ ok: false, error: 'cron_secret_missing' }, { status: 500 })
  }
  const got = request.headers.get('authorization') || ''
  if (got !== `Bearer ${expected}`) return unauthorized()

  const db = createServerClient()
  const nowIso = new Date().toISOString()
  const summary = { promoted: 0, ticks: 0, sent: 0, bounced: 0, errors: [] }

  // STEP 1 — promote scheduled-due campaigns.
  const { data: promoted, error: promoteErr } = await db
    .from('campaigns')
    .update({ status: 'queued' })
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
    .select('id')
  if (promoteErr) {
    console.error('[cron run-campaigns] promote failed:', promoteErr.message)
  } else {
    summary.promoted = promoted?.length || 0
  }

  // STEP 2 — pick campaigns to tick this run.
  const { data: campaigns, error: pickErr } = await db
    .from('campaigns')
    // email_inbox_reply_to (mig 394) — per-location Reply-To default so
    // campaign replies route into the unified inbox (EMAIL-INBOX.1).
    // settings — feeds the FREQ-CAP.1 marketing frequency-cap gate
    // (locations.settings.comms_frequency_cap) inside tickCampaignSend.
    .select('*, locations(name, slug, email_inbox_reply_to, settings)')
    .in('status', ['queued', 'sending'])
    .order('updated_at', { ascending: true })
    .limit(MAX_CAMPAIGNS_PER_TICK)

  if (pickErr) {
    console.error('[cron run-campaigns] pick failed:', pickErr.message)
    return NextResponse.json({ ok: false, ...summary, error: pickErr.message }, { status: 500 })
  }

  for (const campaign of campaigns || []) {
    try {
      const result = await tickCampaignSend(db, campaign)
      summary.ticks += 1
      summary.sent += result.sent || 0
      summary.bounced += result.bounced || 0
      if (result.error) {
        summary.errors.push({ campaign_id: campaign.id, phase: result.phase, error: result.error })
        console.warn(`[cron run-campaigns] campaign ${campaign.id} (${campaign.name}) phase=${result.phase} error: ${result.error}`)
      }
    } catch (err) {
      const msg = err?.message || String(err)
      summary.errors.push({ campaign_id: campaign.id, error: msg })
      console.error(`[cron run-campaigns] campaign ${campaign.id} threw: ${msg}`)
    }
  }

  await stampHeartbeat('run-campaigns')

  return NextResponse.json({ ok: true, ...summary })
}
