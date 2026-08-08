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
import { spawnDueResends } from '@/lib/campaign-resend'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { getEmailCapStatus } from '@/lib/usage-caps'
import { pickFairCampaigns } from '@/lib/campaign-fairness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_CAMPAIGNS_PER_TICK = 3   // limit parallelism within one cron invocation
const FAIR_PICK_WINDOW = 20        // SAAS4-O3 — candidates fetched for the fair pick

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
  // SAAS4-M3 — per-campaign email hard-cap gate on the promotion (the
  // manual send route has the same preflight). A capped org's campaign
  // STAYS scheduled — deferred, not cancelled — and promotes on the
  // next tick after the cap is raised/cleared. Cap status is cached
  // per org for the tick; the check fails OPEN inside the helper.
  const { data: due, error: dueErr } = await db
    .from('campaigns')
    .select('id, location_id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
  if (dueErr) {
    console.error('[cron run-campaigns] promote fetch failed:', dueErr.message)
  } else if (due && due.length > 0) {
    const capByLocation = new Map()
    const promotable = []
    for (const c of due) {
      if (!capByLocation.has(c.location_id)) {
        capByLocation.set(c.location_id, await getEmailCapStatus({ locationId: c.location_id }, { db }))
      }
      if (capByLocation.get(c.location_id).capped) {
        console.warn(`[cron run-campaigns] campaign ${c.id} held at email hard cap (stays scheduled)`)
      } else {
        promotable.push(c.id)
      }
    }
    if (promotable.length > 0) {
      const { data: promoted, error: promoteErr } = await db
        .from('campaigns')
        .update({ status: 'queued' })
        .in('id', promotable)
        .eq('status', 'scheduled')
        .select('id')
      if (promoteErr) {
        console.error('[cron run-campaigns] promote failed:', promoteErr.message)
      } else {
        summary.promoted = promoted?.length || 0
      }
    }
  }

  // STEP 1b — spawn due non-opener resends (CAMPAIGN-RESEND, mig 506).
  // Children are inserted 'queued' and picked up by STEP 2 like any other
  // campaign; a failure here must never block the send ticks.
  try {
    const resends = await spawnDueResends(db)
    summary.resends_spawned = resends.spawned
    if (resends.errors.length > 0) {
      console.warn('[cron run-campaigns] resend spawn errors:', JSON.stringify(resends.errors))
    }
  } catch (err) {
    console.error('[cron run-campaigns] resend spawn failed:', err?.message || err)
  }

  // STEP 2 — pick campaigns to tick this run.
  // SAAS4-O3 — tenant fairness: fetch an age-ordered window, then
  // round-robin by location (one slot per location before any second
  // slot) so a busy tenant's backlog can't occupy every slot and
  // starve other tenants' sends. A lone tenant still gets all slots.
  const { data: window, error: pickErr } = await db
    .from('campaigns')
    // email_inbox_reply_to (mig 394) — per-location Reply-To default so
    // campaign replies route into the unified inbox (EMAIL-INBOX.1).
    // settings — feeds the FREQ-CAP.1 marketing frequency-cap gate
    // (locations.settings.comms_frequency_cap) inside tickCampaignSend.
    .select('*, locations(name, slug, email_inbox_reply_to, settings)')
    .in('status', ['queued', 'sending'])
    .order('updated_at', { ascending: true })
    .limit(FAIR_PICK_WINDOW)

  if (pickErr) {
    console.error('[cron run-campaigns] pick failed:', pickErr.message)
    return NextResponse.json({ ok: false, ...summary, error: pickErr.message }, { status: 500 })
  }

  const campaigns = pickFairCampaigns(window, MAX_CAMPAIGNS_PER_TICK)

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
