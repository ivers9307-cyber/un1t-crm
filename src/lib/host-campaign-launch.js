// HOST-SCHEDULE.1 — the ONE launch path for a host campaign.
//
// Extracted verbatim from POST /api/host/emails/[id]/send (HOST-EMAIL.3 /
// QSTASH.8 / HOST-CONSENT.1) so that Send now and the scheduled fire share
// every gate. Gates, in order:
//
//   1. own campaign (.eq('host_id') is the tenancy boundary) → not_found
//   1b. trigger 'resend_missed' only: status must be 'sent' → not_sent
//   2. sender_domain_verified + sender_email (the UN1T kill switch) → sender_not_verified
//   2b. postmark_stream_id for a marketing send → no_stream
//   3. daily cap — campaigns sending/sent today (UTC) vs email_daily_send_cap → daily_cap
//   4. recipients resolved NOW (consent + per-host suppression) → no_recipients
//      trigger 'resend_missed': the list is then diffed against the
//      campaign's own send rows (resolveMissedRecipients) → nobody_missed
//   5. CAS <from> → sending, stamping recipient_count → cas_lost (0 rows)
//      <from> is 'draft' for trigger 'send_now', 'scheduled' for 'schedule',
//      'sent' for 'resend_missed'.
//      This CAS is the double-send lock for every caller: two clicks, or two
//      overlapping sweeper ticks, and exactly one wins.
//
// Then the fan-out is ENQUEUED (chunked upsert into host_campaign_sends,
// ignoreDuplicates on UNIQUE(campaign_id, contact_id) keeps a retry
// idempotent) and the QStash worker is kicked ONCE, AFTER the last chunk
// (a kick before the rows exist looks "drained" and mis-finalises). A
// partial enqueue returns enqueue_failed and publishes nothing — the
// campaign is already 'sending' and the sweeper cron drains what landed.
//
// HOST-RESEND.1 — trigger 'resend_missed' (POST /api/host/emails/[id]/
// resend-missed) re-launches a SENT campaign for the contacts who never got
// it: everyone the resolver returns now who has no 'sent' row. A contact
// with a 'failed' row (any reason: a send error, a stale claim, or a gate
// refusal that no longer applies because the resolver returns them today)
// is reset to pending through a MERGING upsert (ignoreDuplicates: false) —
// the queue re-gates every claimed row anyway, so a contact still blocked
// simply fails again with a fresh reason. 'sent' rows are excluded from the
// upsert payload, so they are never touched. recipient_count becomes the row
// total after the enqueue (existing rows + newly inserted). The kick gets its
// own dedup id so the original launch's id can't swallow it inside QStash's
// dedup window. The queue's finaliser keeps the FIRST sent_at and stamps
// resent_at (mig 593) when it drains a campaign that already had one.
//
// Returns { ok:true, recipientCount } or { ok:false, reason, status, error }
// where `status` is the HTTP status the send route has always answered
// with and `error` its user-facing message. Reason codes:
//   - Refusals with NO write landed (campaign left untouched): not_found,
//     not_sent (resend only), sender_not_verified, no_stream, daily_cap,
//     no_recipients, nobody_missed (resend only), resolve_failed (the
//     recipient resolver or the send-rows read threw), db_error (a read
//     failed, or the CAS update itself errored: an errored UPDATE commits
//     nothing), cas_lost (the CAS matched 0 rows: someone else won).
//   - Post-CAS failure (campaign is already 'sending'): enqueue_failed (a
//     chunk upsert failed; nothing is published and the sweeper cron
//     drains what landed).

import { resolveHostRecipients } from '@/lib/host-campaign-email'
import { publishQueuePush, HOST_CAMPAIGNS_WORKER_PATH } from '@/lib/qstash'

const ENQUEUE_CHUNK = 500 // rows per host_campaign_sends insert statement
const PAGE = 1000 // 1k-row cap discipline for the existing-rows read

/** User-facing refusal copy — moved from the send route unchanged. */
export const LAUNCH_MESSAGES = Object.freeze({
  not_found: 'Not found',
  not_sent: 'Only a sent email can be resent.',
  sender_not_verified: 'Sending is not enabled — ask UN1T to verify your sending domain.',
  no_stream: 'Marketing sending is not set up for this host yet — ask UN1T to attach your Postmark stream.',
  daily_cap: 'Daily send limit reached.',
  no_recipients: 'No emailable contacts.',
  nobody_missed: 'Everyone who can be emailed already received this.',
  cas_lost: 'This email has already been sent.',
  // cas_lost under trigger 'resend_missed': the campaign left 'sent' between
  // the read and the CAS, so a resend (or another launch) is already in flight.
  resend_in_flight: 'This email is already being resent.',
})

/** The subset of reason codes that are pre-CAS gate refusals (campaign
 * untouched) — exported so the sweeper can import the set instead of
 * re-typing it. */
export const LAUNCH_GATE_REASONS = Object.freeze(['sender_not_verified', 'no_stream', 'daily_cap', 'no_recipients'])

const REFUSAL_STATUS = Object.freeze({
  not_found: 404,
  not_sent: 409,
  sender_not_verified: 409,
  no_stream: 409,
  daily_cap: 409,
  no_recipients: 409,
  nobody_missed: 409,
  cas_lost: 409,
})

const CAS_FROM_STATUS = Object.freeze({
  send_now: 'draft',
  schedule: 'scheduled',
  resend_missed: 'sent',
})

function refuse(reason, error) {
  return { ok: false, reason, status: REFUSAL_STATUS[reason] ?? 500, error: error ?? LAUNCH_MESSAGES[reason] ?? 'Unexpected error' }
}

/**
 * The resolver options a campaign row implies. HOST-GROWTH.11 — audience_kind
 * picks the population. Legacy-row guard: an event id on a non-mailing_list
 * row always means a per-event audience (pre-mig-460 writers left
 * audience_kind at its 'all' default).
 * @param {{ audience_kind?: string, audience_event_id?: string|null, email_type?: string }} campaign
 */
export function resolverOptionsFor(campaign) {
  const audienceEventId = campaign.audience_kind !== 'mailing_list' ? campaign.audience_event_id || null : null
  return {
    audienceEventId,
    mailingListOnly: campaign.audience_kind === 'mailing_list',
    emailType: campaign.email_type === 'utility' ? 'utility' : 'marketing',
  }
}

/**
 * HOST-RESEND.1 — who would a resend reach? The resolver's list NOW minus
 * every contact with a 'sent' row on this campaign. `totalRows` is what
 * recipient_count becomes once the missed list is enqueued: every existing
 * row (sent or failed) plus the missed contacts that have no row yet.
 * Throws on any read error — a partial list would silently skip people.
 *
 * Shared by launchHostCampaign (the write) and the recipients route (the
 * count behind the report page's button), so the button and the send can't
 * disagree.
 * @param {object} db  service-role client
 * @param {{ hostId: string, campaign: { id: string, audience_kind?: string, audience_event_id?: string|null, email_type?: string } }} args
 * @returns {Promise<{ missed: Array<{ contact_id: string, email: string }>, totalRows: number }>}
 */
export async function resolveMissedRecipients(db, { hostId, campaign }) {
  const recipients = await resolveHostRecipients(db, hostId, resolverOptionsFor(campaign))

  const sentIds = new Set()
  const existingIds = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('host_campaign_sends')
      .select('contact_id, status')
      .eq('campaign_id', campaign.id)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`host campaign: send rows read failed: ${error.message}`)
    for (const row of data || []) {
      existingIds.add(row.contact_id)
      if (row.status === 'sent') sentIds.add(row.contact_id)
    }
    if (!data || data.length < PAGE) break
  }

  const missed = recipients.filter((r) => !sentIds.has(r.contact_id))
  const newRows = missed.filter((r) => !existingIds.has(r.contact_id)).length
  return { missed, totalRows: existingIds.size + newRows }
}

/**
 * @param {object} db  service-role client
 * @param {{ campaignId: string, hostId: string, trigger: 'send_now'|'schedule'|'resend_missed' }} args
 * @returns {Promise<{ ok: true, recipientCount: number } | { ok: false, reason: string, status: number, error: string }>}
 */
export async function launchHostCampaign(db, { campaignId, hostId, trigger }) {
  const isResend = trigger === 'resend_missed'
  const fromStatus = CAS_FROM_STATUS[trigger] ?? 'draft'

  const { data: campaign, error: campaignErr } = await db
    .from('host_campaigns')
    .select('id, status, audience_kind, audience_event_id, email_type')
    .eq('id', campaignId)
    .eq('host_id', hostId)
    .maybeSingle()
  if (campaignErr) return refuse('db_error', campaignErr.message)
  if (!campaign) return refuse('not_found')
  // The CAS below would refuse this too, but with the wrong words; a resend
  // of anything but a sent campaign is a distinct, plain refusal.
  if (isResend && campaign.status !== 'sent') return refuse('not_sent')

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
  // later by the scheduler (or resent later) neither consumes nor is limited
  // by today's cap — a known gap on that axis, not fixed by this spec.
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
  // A resend then subtracts everyone who already has a 'sent' row.
  let recipients
  let recipientCountAfter
  try {
    if (isResend) {
      const { missed, totalRows } = await resolveMissedRecipients(db, { hostId, campaign })
      recipients = missed
      recipientCountAfter = totalRows
    } else {
      recipients = await resolveHostRecipients(db, hostId, resolverOptionsFor(campaign))
      recipientCountAfter = recipients.length
    }
  } catch (e) {
    return refuse('resolve_failed', e?.message || String(e))
  }
  if (recipients.length === 0) return refuse(isResend ? 'nobody_missed' : 'no_recipients')

  // CAS <from>→sending — the double-launch guard. 0 rows = someone else won.
  const { data: claimed, error: casErr } = await db
    .from('host_campaigns')
    .update({ status: 'sending', recipient_count: recipientCountAfter })
    .eq('id', campaign.id)
    .eq('status', fromStatus)
    .select('id')
  if (casErr) return refuse('db_error', casErr.message)
  if (!claimed || claimed.length === 0) return refuse('cas_lost', isResend ? LAUNCH_MESSAGES.resend_in_flight : undefined)

  // A resend MERGES (ignoreDuplicates: false) so an old failed row comes back
  // to pending with its failure cleared; a first launch ignores duplicates so
  // a retried enqueue is idempotent.
  const rows = recipients.map((r) => ({
    campaign_id: campaign.id,
    contact_id: r.contact_id,
    email: r.email,
    status: 'pending',
    ...(isResend ? { failed_reason: null, claimed_at: null } : {}),
  }))
  for (let i = 0; i < rows.length; i += ENQUEUE_CHUNK) {
    const chunk = rows.slice(i, i + ENQUEUE_CHUNK)
    const { error } = await db
      .from('host_campaign_sends')
      .upsert(chunk, { onConflict: 'campaign_id,contact_id', ignoreDuplicates: !isResend })
    if (error) return refuse('enqueue_failed', `Queueing failed: ${error.message}`)
  }

  // QSTASH.8 — one campaign-level kick, after every chunk landed. Dedup id
  // is DASH-ONLY (QStash 400s on colons). Fire-and-forget. A resend gets a
  // fresh id per launch (see header).
  try {
    await publishQueuePush({
      path: HOST_CAMPAIGNS_WORKER_PATH,
      body: { campaignId: campaign.id },
      deduplicationId: isResend ? `host-campaign-${campaign.id}-resend-${Date.now()}` : `host-campaign-${campaign.id}-kick`,
    })
  } catch {
    // publishQueuePush swallows its own errors; belt-and-braces only.
  }

  return { ok: true, recipientCount: recipients.length }
}
