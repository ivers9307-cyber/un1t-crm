// HOST-SCHEDULE.1 — the ONE launch path for a host campaign.
//
// Extracted verbatim from POST /api/host/emails/[id]/send (HOST-EMAIL.3 /
// QSTASH.8 / HOST-CONSENT.1) so that Send now and the scheduled fire share
// every gate. Gates, in order:
//
//   1. own campaign (.eq('host_id') is the tenancy boundary) → not_found
//   2. sender_domain_verified + sender_email (the UN1T kill switch) → sender_not_verified
//   2b. postmark_stream_id for a marketing send → no_stream
//   3. daily cap — campaigns sending/sent today (UTC) vs email_daily_send_cap → daily_cap
//   4. recipients resolved NOW (consent + per-host suppression) → no_recipients
//   5. CAS <from> → sending, stamping recipient_count → cas_lost (0 rows)
//      <from> is 'draft' for trigger 'send_now', 'scheduled' for 'schedule'.
//      This CAS is the double-send lock for both callers: two clicks, or two
//      overlapping sweeper ticks, and exactly one wins.
//
// Then the fan-out is ENQUEUED (chunked upsert into host_campaign_sends,
// ignoreDuplicates on UNIQUE(campaign_id, contact_id) keeps a retry
// idempotent) and the QStash worker is kicked ONCE, AFTER the last chunk
// (a kick before the rows exist looks "drained" and mis-finalises). A
// partial enqueue returns enqueue_failed and publishes nothing — the
// campaign is already 'sending' and the sweeper cron drains what landed.
//
// Returns { ok:true, recipientCount } or { ok:false, reason, status, error }
// where `status` is the HTTP status the send route has always answered
// with and `error` its user-facing message. Reason codes:
//   - Refusals with NO write landed (campaign left untouched): not_found,
//     sender_not_verified, no_stream, daily_cap, no_recipients,
//     resolve_failed (the recipient resolver threw), db_error (a read
//     failed, or the CAS update itself errored: an errored UPDATE commits
//     nothing), cas_lost (the CAS matched 0 rows: someone else won).
//   - Post-CAS failure (campaign is already 'sending'): enqueue_failed (a
//     chunk upsert failed; nothing is published and the sweeper cron
//     drains what landed).

import { resolveHostRecipients } from '@/lib/host-campaign-email'
import { publishQueuePush, HOST_CAMPAIGNS_WORKER_PATH } from '@/lib/qstash'

const ENQUEUE_CHUNK = 500 // rows per host_campaign_sends insert statement

/** User-facing refusal copy — moved from the send route unchanged. */
export const LAUNCH_MESSAGES = Object.freeze({
  not_found: 'Not found',
  sender_not_verified: 'Sending is not enabled — ask UN1T to verify your sending domain.',
  no_stream: 'Marketing sending is not set up for this host yet — ask UN1T to attach your Postmark stream.',
  daily_cap: 'Daily send limit reached.',
  no_recipients: 'No emailable contacts.',
  cas_lost: 'This email has already been sent.',
})

/** The subset of reason codes that are pre-CAS gate refusals (campaign
 * untouched) — exported so the sweeper can import the set instead of
 * re-typing it. */
export const LAUNCH_GATE_REASONS = Object.freeze(['sender_not_verified', 'no_stream', 'daily_cap', 'no_recipients'])

const REFUSAL_STATUS = Object.freeze({
  not_found: 404,
  sender_not_verified: 409,
  no_stream: 409,
  daily_cap: 409,
  no_recipients: 409,
  cas_lost: 409,
})

function refuse(reason, error) {
  return { ok: false, reason, status: REFUSAL_STATUS[reason] ?? 500, error: error ?? LAUNCH_MESSAGES[reason] ?? 'Unexpected error' }
}

/**
 * @param {object} db  service-role client
 * @param {{ campaignId: string, hostId: string, trigger: 'send_now'|'schedule' }} args
 * @returns {Promise<{ ok: true, recipientCount: number } | { ok: false, reason: string, status: number, error: string }>}
 */
export async function launchHostCampaign(db, { campaignId, hostId, trigger }) {
  const fromStatus = trigger === 'schedule' ? 'scheduled' : 'draft'

  const { data: campaign, error: campaignErr } = await db
    .from('host_campaigns')
    .select('id, status, audience_kind, audience_event_id, email_type')
    .eq('id', campaignId)
    .eq('host_id', hostId)
    .maybeSingle()
  if (campaignErr) return refuse('db_error', campaignErr.message)
  if (!campaign) return refuse('not_found')

  // Sender identity — HOST_PORTAL_COLS deliberately excludes the sender
  // columns, so load them here. Missing sender_email with verified=true is a
  // provisioning inconsistency; treat it as not-enabled rather than sending
  // from a broken From header.
  const { data: host, error: hostErr } = await db
    .from('event_hosts')
    .select('id, sender_domain_verified, sender_email, email_daily_send_cap, postmark_stream_id')
    .eq('id', hostId)
    .maybeSingle()
  if (hostErr) return refuse('db_error', hostErr.message)
  if (!host) return refuse('not_found')
  if (!host.sender_domain_verified || !host.sender_email) return refuse('sender_not_verified')

  // HOST-CONSENT.1 — marketing needs the host's own Postmark stream.
  if (campaign.email_type !== 'utility' && !host.postmark_stream_id) return refuse('no_stream')

  // Daily cap: campaigns this host has put into flight today (UTC midnight —
  // matches the cap's plain reading, no BST wobble on the boundary). The
  // count filters on created_at, so a campaign CREATED earlier but FIRED
  // later by the scheduler neither consumes nor is limited by today's cap —
  // a known gap on that axis, not fixed by this spec.
  const now = new Date()
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
  const { count: sentToday, error: capErr } = await db
    .from('host_campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('host_id', hostId)
    .in('status', ['sending', 'sent'])
    .gte('created_at', utcMidnight)
  if (capErr) return refuse('db_error', capErr.message)
  const cap = host.email_daily_send_cap ?? 2
  if ((sentToday || 0) >= cap) return refuse('daily_cap')

  // Recipients resolve at launch time — consent + per-host suppression + dedupe.
  // HOST-GROWTH.11 — audience_kind picks the population. Legacy-row guard:
  // an event id on a non-mailing_list row always means a per-event audience
  // (pre-mig-460 writers left audience_kind at its 'all' default).
  let recipients
  try {
    const audienceEventId = campaign.audience_kind !== 'mailing_list' ? campaign.audience_event_id || null : null
    recipients = await resolveHostRecipients(db, hostId, {
      audienceEventId,
      mailingListOnly: campaign.audience_kind === 'mailing_list',
      emailType: campaign.email_type === 'utility' ? 'utility' : 'marketing',
    })
  } catch (e) {
    return refuse('resolve_failed', e?.message || String(e))
  }
  if (recipients.length === 0) return refuse('no_recipients')

  // CAS <from>→sending — the double-launch guard. 0 rows = someone else won.
  const { data: claimed, error: casErr } = await db
    .from('host_campaigns')
    .update({ status: 'sending', recipient_count: recipients.length })
    .eq('id', campaign.id)
    .eq('status', fromStatus)
    .select('id')
  if (casErr) return refuse('db_error', casErr.message)
  if (!claimed || claimed.length === 0) return refuse('cas_lost')

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
    if (error) return refuse('enqueue_failed', `Queueing failed: ${error.message}`)
  }

  // QSTASH.8 — one campaign-level kick, after every chunk landed. Dedup id
  // is DASH-ONLY (QStash 400s on colons). Fire-and-forget.
  try {
    await publishQueuePush({
      path: HOST_CAMPAIGNS_WORKER_PATH,
      body: { campaignId: campaign.id },
      deduplicationId: `host-campaign-${campaign.id}-kick`,
    })
  } catch {
    // publishQueuePush swallows its own errors; belt-and-braces only.
  }

  return { ok: true, recipientCount: recipients.length }
}
