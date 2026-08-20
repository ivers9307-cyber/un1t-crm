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

// COMMSFIX.C.5 — how long a campaign may sit erroring before it is declared
// dead rather than retrying. Short enough that an operator finds out the same
// morning; long enough that a Postmark blip or a deploy mid-tick is ridden out.
export const QUEUED_FAILURE_GRACE_MS = 15 * 60_000

const MAX_LAST_ERROR_CHARS = 1000

/**
 * COMMSFIX.C.5 — decide what a failing tick writes onto the campaign row.
 *
 * Every failing tick stamps `last_error` (mig 509): before this, a failure left
 * NO trace on any operator surface — the campaign kept status 'queued' and
 * /communications/sent showed a cheerful amber chip while nothing was
 * happening. The 8 Aug audience truncation lived in exactly that blind spot.
 *
 * The status only flips to 'failed' once the campaign is genuinely stuck:
 *   • an error was ALREADY on the row coming into this tick, so this is at
 *     least the second consecutive failure, not one blip;
 *   • `send_started_at` is null, so populate never completed — once chunks are
 *     going out, individual failures are the recipient-level retry machinery's
 *     job (CAMPAIGN-REL.1/.2) and the campaign must not be killed around them;
 *   • the campaign is older than the grace window.
 *
 * Pure and exported so the decision is testable without the cron's plumbing.
 *
 * @param {{ id: string, created_at?: string, send_started_at?: string|null, last_error?: string|null }} campaign
 *   the row AS READ AT THE START OF THIS TICK — `last_error` is therefore the
 *   PREVIOUS tick's error, which is what makes the "already failing" test work.
 * @param {unknown} error
 * @param {number} [now]
 * @returns {{ last_error: string, status?: 'failed' }}
 */
export function campaignFailurePatch(campaign, error, now = Date.now()) {
  const message = (error instanceof Error ? error.message : String(error ?? 'unknown error'))
    .slice(0, MAX_LAST_ERROR_CHARS)
  const patch = { last_error: message }

  const createdAt = campaign?.created_at ? Date.parse(campaign.created_at) : NaN
  const stuck =
    Boolean(campaign?.last_error) &&
    !campaign?.send_started_at &&
    Number.isFinite(createdAt) &&
    now - createdAt > QUEUED_FAILURE_GRACE_MS

  if (stuck) patch.status = 'failed'
  return patch
}

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
    // COMMSFIX.D.2e — subject/html_content are read so the promote step can
    // refuse a bodyless campaign (see the guard below).
    .select('id, location_id, subject, html_content')
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
  if (dueErr) {
    console.error('[cron run-campaigns] promote fetch failed:', dueErr.message)
  } else if (due && due.length > 0) {
    const capByLocation = new Map()
    const promotable = []
    for (const c of due) {
      // COMMSFIX.D.2e — never promote a campaign with no body or no subject.
      // Postmark permanently rejects HtmlBody null, so promoting one turns the
      // whole audience into bounces. Held (stays 'scheduled'), not cancelled —
      // the operator can fix the body and it promotes on the next tick. Logged
      // via console.error and counted in the response so it is prod-visible.
      if (!c.subject || !String(c.subject).trim() || !c.html_content || !String(c.html_content).trim()) {
        console.error(`[cron run-campaigns] campaign ${c.id} NOT promoted — empty subject or body (stays scheduled)`)
        summary.blocked_empty = (summary.blocked_empty || 0) + 1
        continue
      }
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
    // features (TENANT.8 item 3b) — feeds the location bundle/feature
    // gate (isFeatureEnabledAtLocation(campaign.locations, 'email'))
    // inside tickCampaignSend.
    .select('*, locations(name, slug, email_inbox_reply_to, settings, features)')
    .in('status', ['queued', 'sending'])
    .order('updated_at', { ascending: true })
    .limit(FAIR_PICK_WINDOW)

  if (pickErr) {
    console.error('[cron run-campaigns] pick failed:', pickErr.message)
    return NextResponse.json({ ok: false, ...summary, error: pickErr.message }, { status: 500 })
  }

  const campaigns = pickFairCampaigns(window, MAX_CAMPAIGNS_PER_TICK)

  for (const campaign of campaigns || []) {
    // COMMSFIX.C.5 — whatever went wrong, it lands on the campaign row.
    let tickError = null
    try {
      const result = await tickCampaignSend(db, campaign)
      summary.ticks += 1
      summary.sent += result.sent || 0
      summary.bounced += result.bounced || 0
      if (result.error) {
        tickError = result.error
        summary.errors.push({ campaign_id: campaign.id, phase: result.phase, error: result.error })
        console.warn(`[cron run-campaigns] campaign ${campaign.id} (${campaign.name}) phase=${result.phase} error: ${result.error}`)
      }
      // BAREWRITE.4 — a tick may report a problem that must be VISIBLE without
      // being grounds to kill the campaign. The rotation bumps are the case
      // that forced the distinction: the bundle-disabled path writes
      // `last_error` every tick by design, so any `error` it returns satisfies
      // campaignFailurePatch's "already failing" test on the very first
      // occurrence and one transient blip marked the campaign 'failed'
      // permanently. Warnings are logged at error level and counted, but never
      // reach campaignFailurePatch.
      if (result.warning) {
        summary.warnings = summary.warnings || []
        summary.warnings.push({ campaign_id: campaign.id, phase: result.phase, warning: result.warning })
        console.error(`[cron run-campaigns] campaign ${campaign.id} (${campaign.name}) phase=${result.phase} WARNING: ${result.warning}`)
      }
    } catch (err) {
      const msg = err?.message || String(err)
      tickError = msg
      summary.errors.push({ campaign_id: campaign.id, error: msg })
      console.error(`[cron run-campaigns] campaign ${campaign.id} threw: ${msg}`)
    }

    if (tickError) {
      const patch = campaignFailurePatch(campaign, tickError)
      const { error: stampErr } = await db.from('campaigns').update(patch).eq('id', campaign.id)
      if (stampErr) {
        console.error(`[cron run-campaigns] could not stamp last_error on ${campaign.id}: ${stampErr.message}`)
      } else if (patch.status === 'failed') {
        summary.failed = (summary.failed || 0) + 1
        console.error(`[cron run-campaigns] campaign ${campaign.id} (${campaign.name}) marked FAILED after repeated errors: ${patch.last_error}`)
      }
    }
  }

  await stampHeartbeat('run-campaigns')

  return NextResponse.json({ ok: true, ...summary })
}
