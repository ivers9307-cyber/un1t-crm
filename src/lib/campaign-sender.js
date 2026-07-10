// CAMPAIGN.13 — chunk-aware campaign sender.
//
// Replaces the all-in-one sendCampaign that loaded the full audience
// + sent everything in a single function invocation (timed out for
// large audiences, locked the operator's browser, and burst the
// Postmark webhook receiver). New shape:
//
//   1. Operator clicks "Send" or scheduled_at fires → campaign
//      moves to status='queued' (no work in the request thread).
//   2. /api/cron/run-campaigns picks queued campaigns up. First
//      invocation per campaign:
//        a. Load audience (paginated — CAMPAIGN.11 fix).
//        b. Pre-populate campaign_recipients (status='queued',
//           one row per intended recipient).
//        c. Set status='sending'.
//      Subsequent invocations:
//        d0. Reclaim lease-expired 'sending' rows (CAMPAIGN-REL.2).
//        d. SELECT first CHUNK_SIZE campaign_recipients WHERE
//           status='queued' for this campaign, CAS-claim them
//           queued→sending (claimed_at stamps the lease).
//        e. Send them via Postmark batch.
//        f. UPDATE each to 'sent' / 'bounced' (permanent rejection) /
//           back to 'queued' (transient error, attempts+1, capped at
//           MAX_SEND_ATTEMPTS then 'failed') + log sends to email_sends.
//        g. Check campaigns.cancel_requested_at — if set, halt and
//           transition status='cancelled'.
//        h. If no more queued for this campaign, status='sent',
//           call recalculate_campaign_stats.
//
// Throttle: each cron tick processes one CHUNK_SIZE (500) per
// campaign and at most MAX_CAMPAIGNS_PER_TICK campaigns. With a
// 1-minute cron, that gives ~500/min/campaign, well under
// Postmark's batch limits and well within the deferred-webhook
// queue's drain rate.
//
// CAMPAIGN-AB (mig 398) — subject-line A/B testing. When
// campaigns.ab_subject_b is set, the same tick function runs a
// column-driven sub-machine (resolveAbPhase, src/lib/campaign-ab.js):
//
//   populate  — recipients get a deterministic ab_variant
//               ('a'|'b' for the ab_test_pct% test slice, NULL for
//               the remainder) stamped at populate time, so the
//               assignment is stable across ticks.
//   slice     — chunk selection is restricted to ab_variant IS NOT
//               NULL; each row's subject comes from its variant
//               (A = campaigns.subject, B = ab_subject_b). When the
//               slice fully drains (nothing queued OR sending),
//               ab_test_started_at is CAS-stamped (…IS NULL guard).
//   waiting   — now < started + ab_wait_hours: the tick no-ops for
//               the remainder (it only touches updated_at so the
//               waiting campaign rotates to the back of the cron's
//               pick order instead of hogging a per-tick slot).
//   decide    — open rates per variant come from the
//               campaign_ab_variant_stats RPC (email_sends joined
//               via campaign_recipients.ab_variant); ties/zero-data
//               go to A. ab_winner is CAS-stamped (…IS NULL) so
//               exactly one overlapping tick decides; the winner
//               falls through and starts sending the remainder.
//   final     — the normal chunked path, each row's subject resolved
//               via subjectForVariant (remainder → winning subject;
//               retried slice rows keep their own variant).
//
// Campaigns without ab_subject_b never enter the sub-machine — the
// default path is unchanged. Cancel (cancel_requested_at) is checked
// before any phase work, so mid-test cancels behave exactly like
// mid-send cancels.

import { buildAudienceQueryAsync, applyMergeTags, buildUnsubscribeUrl, appendUnsubscribeFooter, sendBatch, consentFieldForStream, isTransientSendError } from './postmark.js'
import { injectPreheader, htmlToPlainText } from './email-content.js'
import { resolveAbPhase, assignAbVariants, clampAbTestPct, decideAbWinner, subjectForVariant } from './campaign-ab.js'
import { getAppUrl } from './app-url.js'

const CHUNK_SIZE = 500             // recipients per cron tick per campaign
const AUDIENCE_PAGE_SIZE = 1000    // audience load page (CAMPAIGN.11)
const RECIPIENT_INSERT_CHUNK = 1000

// CAMPAIGN-REL.1 — bounded retry for transient provider errors.
// A recipient is attempted at most MAX_SEND_ATTEMPTS times; each
// transient failure (network blip, HTTP 429/5xx, Postmark rate
// limit/maintenance) returns it to 'queued' with attempts+1 until
// the cap, then it's marked 'failed'. Permanent rejections (invalid
// address, inactive recipient) never retry. Requires the
// campaign_recipients.attempts / claimed_at columns (mig 392).
export const MAX_SEND_ATTEMPTS = 3

// CAMPAIGN-REL.2 — how long a 'sending' claim is honoured before a
// later tick assumes the claiming invocation died mid-flight and
// reclaims the row. Mirrors the sequences scheduler's CLAIM_LEASE_MS
// (src/lib/sequences/scheduler.js): long enough to cover a tick's
// processing, short enough that a crashed tick's rows retry promptly.
export const SENDING_LEASE_MS = 10 * 60_000

/**
 * Process one cron tick of work for one campaign.
 *
 * @param {SupabaseClient} db — service-role client
 * @param {object} campaign — full campaigns row (joined with locations(name, slug))
 * @returns {Promise<{ phase: string, sent?: number, error?: string }>}
 */
export async function tickCampaignSend(db, campaign) {
  const campaignId = campaign.id

  // Marketing (broadcast) vs Utility (outbound). Drives the consent gate,
  // the Postmark stream, and whether an unsubscribe footer is appended.
  const stream = campaign.postmark_stream === 'outbound' ? 'outbound' : 'broadcast'
  const consentField = consentFieldForStream(stream)

  // Hard stop — cancel-while-sending.
  if (campaign.cancel_requested_at) {
    await db.from('campaign_recipients')
      .update({ status: 'cancelled' })
      .eq('campaign_id', campaignId)
      .eq('status', 'queued')
    await db.from('campaigns')
      .update({ status: 'cancelled', sent_at: new Date().toISOString() })
      .eq('id', campaignId)
    return { phase: 'cancelled' }
  }

  // Phase 1 — if the campaign has no recipients yet, populate them.
  // This happens on the FIRST cron tick after the operator queues
  // the campaign. We don't send any emails this tick — populate
  // is its own time budget. Next tick picks up the first chunk.
  const { count: existingCount } = await db
    .from('campaign_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)

  if ((existingCount || 0) === 0) {
    const contacts = []
    for (let from = 0; ; from += AUDIENCE_PAGE_SIZE) {
      const { query } = await buildAudienceQueryAsync(db, campaign.audience_filter, campaign.location_id, { consentField })
      const { data, error } = await query.range(from, from + AUDIENCE_PAGE_SIZE - 1)
      if (error) return { phase: 'populate', error: `audience load failed: ${error.message}` }
      if (!data || data.length === 0) break
      contacts.push(...data)
      if (data.length < AUDIENCE_PAGE_SIZE) break
    }

    if (contacts.length === 0) {
      await db.from('campaigns').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        total_recipients: 0,
      }).eq('id', campaignId)
      return { phase: 'populate', sent: 0 }
    }

    // CAMPAIGN-AB — assign the test slice at populate time so it's
    // stable across ticks. Deterministic (hash-ordered) inside
    // assignAbVariants; the DB row is the source of truth afterwards.
    // The ab_variant key is only written for A/B campaigns so the
    // default path's insert payload is byte-identical to today.
    const abEnabled = !!campaign.ab_subject_b
    const variantById = abEnabled
      ? assignAbVariants(contacts.map(c => c.id), clampAbTestPct(campaign.ab_test_pct))
      : null

    // Bulk insert recipients in chunks.
    const recipientRows = contacts.map(c => {
      const row = {
        campaign_id: campaignId,
        contact_id: c.id,
        status: 'queued',
      }
      if (abEnabled) row.ab_variant = variantById.get(c.id) || null
      return row
    })
    for (let i = 0; i < recipientRows.length; i += RECIPIENT_INSERT_CHUNK) {
      const chunk = recipientRows.slice(i, i + RECIPIENT_INSERT_CHUNK)
      const { error } = await db.from('campaign_recipients').insert(chunk)
      if (error) return { phase: 'populate', error: `recipient insert failed: ${error.message}` }
    }

    const populateUpdate = {
      status: 'sending',
      total_recipients: contacts.length,
      send_started_at: new Date().toISOString(),
    }
    // CAMPAIGN-AB — an audience too small to test (assignAbVariants
    // returned no slice) short-circuits straight to winner A so the
    // campaign doesn't sit through a pointless wait window.
    if (abEnabled && variantById.size === 0) {
      const nowIso = new Date().toISOString()
      populateUpdate.ab_winner = 'a'
      populateUpdate.ab_test_started_at = nowIso
      populateUpdate.ab_decided_at = nowIso
    }
    await db.from('campaigns').update(populateUpdate).eq('id', campaignId)

    return { phase: 'populate', sent: 0 }
  }

  // CAMPAIGN-REL.2 — reclaim stuck 'sending' rows BEFORE reading the
  // queue. If a cron invocation dies between the CAS claim (queued→
  // sending below) and result application, its rows stay 'sending'
  // forever — and finalisation (which only checks remaining 'queued')
  // would close the campaign as 'sent' around them. Rows whose lease
  // (claimed_at) expired — or that predate leasing entirely
  // (claimed_at IS NULL) — go back to 'queued' for another attempt,
  // or to 'failed' once the attempt cap is spent. NOTE: a crashed
  // tick MAY have handed the batch to Postmark before dying, so a
  // reclaimed retry can double-send — that's the accepted trade
  // (bounded by MAX_SEND_ATTEMPTS) versus silently never delivering.
  await reclaimStuckSending(db, campaignId)

  // CAMPAIGN-AB — derive the A/B phase from the campaign row (pure,
  // so overlapping cron ticks agree; the transitions below are CAS'd).
  const abPhase = resolveAbPhase(campaign)
  // Set by the tick that wins the decide CAS — its local campaign row
  // predates the ab_winner stamp, so subject resolution needs the
  // freshly decided winner explicitly.
  let abWinnerOverride = null

  if (abPhase === 'waiting') {
    // Inside the wait window: the remainder must not send yet. Touch
    // updated_at so this campaign rotates to the BACK of the cron's
    // pick order (run-campaigns orders by updated_at ascending and
    // ticks at most MAX_CAMPAIGNS_PER_TICK campaigns) — otherwise an
    // hours-long wait would pin one of the per-tick slots and starve
    // other queued campaigns.
    await db.from('campaigns')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', campaignId)
    return { phase: 'ab_waiting', sent: 0 }
  }

  if (abPhase === 'decide') {
    // Open rate per variant from email_sends (same source of truth as
    // recalculate_campaign_stats), joined via campaign_recipients.ab_variant
    // inside the campaign_ab_variant_stats RPC (mig 398).
    const { data: statRows, error: statsErr } = await db
      .rpc('campaign_ab_variant_stats', { p_campaign_id: campaignId })
    if (statsErr) return { phase: 'ab_decide', error: `variant stats failed: ${statsErr.message}` }

    const winner = decideAbWinner(statRows || [])
    // CAS on ab_winner IS NULL — exactly one overlapping tick decides.
    const { data: won } = await db.from('campaigns')
      .update({ ab_winner: winner, ab_decided_at: new Date().toISOString() })
      .eq('id', campaignId)
      .is('ab_winner', null)
      .select('id')
    if (!won || won.length === 0) {
      // A concurrent tick decided first; the next tick sends with its winner.
      return { phase: 'ab_decide', sent: 0 }
    }
    abWinnerOverride = winner
    // Fall through — the deciding tick starts the remainder immediately.
  }

  // Phase 2 — process one CHUNK_SIZE batch of queued recipients.
  // Join contacts inline so we have email + name + preferences for
  // the merge tags + unsubscribe URL without a second round-trip.
  // During the A/B slice phase only test-slice rows (ab_variant set)
  // are eligible; the remainder stays queued but unclaimable.
  let queuedQuery = db
    .from('campaign_recipients')
    .select(`
      id,
      contact_id,
      attempts,
      ab_variant,
      contact:contacts!inner(
        id, email, first_name, last_name, name, phone, pipeline_stage_slug,
        email_status, email_marketing, email_administrative, glofox_passcode,
        contact_preferences(unsubscribe_token)
      )
    `)
    .eq('campaign_id', campaignId)
    .eq('status', 'queued')
  if (abPhase === 'slice') {
    queuedQuery = queuedQuery.not('ab_variant', 'is', null)
  }
  const { data: candidateRows, error: queuedErr } = await queuedQuery
    .order('id', { ascending: true })
    .limit(CHUNK_SIZE)

  if (queuedErr) return { phase: 'send', error: `queued fetch failed: ${queuedErr.message}` }

  if (!candidateRows || candidateRows.length === 0) {
    if (abPhase === 'slice') {
      // Slice drained — but only start the wait clock once nothing is
      // still in flight ('sending' within its lease). Reclaim above
      // already returned lease-expired rows to the queue.
      const { count: inflight } = await db
        .from('campaign_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .eq('status', 'sending')
        .not('ab_variant', 'is', null)
      if ((inflight || 0) > 0) return { phase: 'ab_slice', sent: 0 }

      // CAS on ab_test_started_at IS NULL — one tick starts the clock.
      await db.from('campaigns')
        .update({ ab_test_started_at: new Date().toISOString() })
        .eq('id', campaignId)
        .is('ab_test_started_at', null)
      return { phase: 'ab_test_started', sent: 0 }
    }

    // Done — no more queued. Finalize.
    await db.from('campaigns').update({
      status: 'sent',
      sent_at: campaign.sent_at || new Date().toISOString(),
    }).eq('id', campaignId)

    await db.rpc('recalculate_campaign_stats', { p_campaign_id: campaignId })
      .then(({ error }) => { if (error) console.error('[campaign-sender] recalc failed:', error.message) })

    return { phase: 'finalise', sent: 0 }
  }

  // Double-send guard (HIGH) — Vercel cron does NOT skip an overlapping
  // invocation, so two ticks can SELECT the same queued chunk and both
  // call sendBatch. Atomically claim the chunk: flip queued→sending and
  // keep only the rows THIS tick won. A concurrent tick re-evaluates
  // status='queued' after our row lock releases, matches 0 of these ids,
  // and claims a different chunk — so no recipient is ever sent twice.
  const candidateIds = candidateRows.map(r => r.id)
  const { data: claimedRows } = await db
    .from('campaign_recipients')
    // claimed_at starts the CAMPAIGN-REL.2 lease clock — see
    // reclaimStuckSending above.
    .update({ status: 'sending', claimed_at: new Date().toISOString() })
    .in('id', candidateIds)
    .eq('status', 'queued')
    .select('id')
  const claimedIds = new Set((claimedRows || []).map(r => r.id))
  const claimed = candidateRows.filter(r => claimedIds.has(r.id))
  if (claimed.length === 0) {
    // Another concurrent tick claimed this whole chunk — nothing to do.
    return { phase: 'send', sent: 0, bounced: 0 }
  }

  // Consent re-check (HIGH) — the audience was filtered at POPULATE time,
  // possibly many ticks (minutes) ago. A contact who has since unsubscribed
  // or hard-bounced must NOT be emailed. Re-apply the exact populate-time
  // gate (postmark.js buildAudienceQuery): consent for this stream still
  // granted AND email_status not bounced/complained.
  const consentOk = (c) => {
    const granted = stream === 'outbound' ? c.email_administrative === true : c.email_marketing === true
    return granted && !['bounced', 'complained'].includes(c.email_status)
  }
  const suppressed = claimed.filter(r => !consentOk(r.contact))
  const queuedRows = claimed.filter(r => consentOk(r.contact))
  if (suppressed.length > 0) {
    // Park them out of the queue without sending. Engagement counters are
    // sourced from email_sends (recalculate_campaign_stats), so a 'cancelled'
    // recipient row simply never counts as sent — no stat corruption.
    await db.from('campaign_recipients')
      .update({ status: 'cancelled' })
      .in('id', suppressed.map(r => r.id))
  }
  if (queuedRows.length === 0) {
    return { phase: 'send', sent: 0, bounced: 0, suppressed: suppressed.length }
  }

  // Build email batch for this chunk.
  const baseUrl = getAppUrl()
  const emailBatch = queuedRows.map(row => {
    const contact = row.contact
    // Utility (outbound) emails carry no marketing chrome — no unsubscribe
    // footer, no List-Unsubscribe header, empty {{unsubscribe_url}} merge tag.
    const unsubscribeUrl = stream === 'broadcast' ? buildUnsubscribeUrl(contact, baseUrl) : null
    const prefs = contact.contact_preferences?.[0] || contact.contact_preferences
    const preferenceUrl = `${baseUrl}/preferences/${prefs?.unsubscribe_token || contact.id}`

    const merged = applyMergeTags(campaign.html_content, contact, {
      location_name: campaign.locations?.name || '',
      unsubscribe_url: unsubscribeUrl,
      preference_url: preferenceUrl,
    })
    const personalizedHtml = unsubscribeUrl ? appendUnsubscribeFooter(merged, unsubscribeUrl) : merged

    // CAMPAIGN-REL.4 — derive the plain-text alternative from the
    // rendered content BEFORE the preheader goes in (the preheader is
    // inbox chrome, not content — it shouldn't lead the text part).
    const textBody = htmlToPlainText(personalizedHtml)

    // CAMPAIGN-REL.3 — campaigns.preview_text was collected/stored by
    // the editor but never used at send time. Inject it as a standard
    // hidden preheader, first thing inside the body, merge tags applied.
    const previewText = campaign.preview_text
      ? applyMergeTags(campaign.preview_text, contact, { location_name: campaign.locations?.name || '' })
      : null
    const finalHtml = previewText ? injectPreheader(personalizedHtml, previewText) : personalizedHtml

    // CAMPAIGN-AB — per-recipient subject: variant A/B in the test
    // slice, the winning subject for the remainder. Non-A/B campaigns
    // always resolve to campaign.subject (identical to before).
    const rawSubject = subjectForVariant(campaign, row.ab_variant, abWinnerOverride)

    return {
      to: contact.email,
      subject: applyMergeTags(rawSubject, contact),
      htmlBody: finalHtml,
      textBody,
      from: campaign.from_name
        ? `${campaign.from_name} <${campaign.from_email || process.env.POSTMARK_FROM_EMAIL}>`
        : undefined,
      // EMAIL-INBOX.1 — a per-campaign reply_to still wins; otherwise
      // default to the location's inbound-inbox address (mig 394) so
      // replies land in the unified inbox instead of an external mailbox.
      replyTo: campaign.reply_to || campaign.locations?.email_inbox_reply_to || undefined,
      stream,
      tag: `campaign-${campaignId}`,
      metadata: {
        campaign_id: campaignId,
        contact_id: contact.id,
      },
      unsubscribeUrl,
      _recipientId: row.id,
      _contactId: contact.id,
      _attempts: row.attempts || 0,
      _rawSubject: rawSubject,
    }
  })

  const results = await sendBatch(emailBatch)

  // Apply results.
  let sentCount = 0
  let bouncedCount = 0
  let retriedCount = 0
  let failedCount = 0
  const sendRecords = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const item = emailBatch[i]

    if (result.ErrorCode === 0 || result.MessageID) {
      sentCount++
      await db.from('campaign_recipients')
        .update({
          status: 'sent',
          postmark_message_id: result.MessageID,
          sent_at: new Date().toISOString(),
        })
        .eq('id', item._recipientId)

      sendRecords.push({
        contact_id: item._contactId,
        location_id: campaign.location_id,
        source_type: 'campaign',
        campaign_id: campaignId,
        // CAMPAIGN-AB — log the subject this recipient actually got
        // (variant B / winning subject), not blindly campaign.subject.
        subject: item._rawSubject,
        from_email: campaign.from_email || process.env.POSTMARK_FROM_EMAIL,
        to_email: item.to,
        postmark_message_id: result.MessageID,
        postmark_stream: stream,
        status: 'sent',
      })
    } else if (isTransientSendError(result)) {
      // CAMPAIGN-REL.1 — transient (network/-1, HTTP 429/5xx, Postmark
      // rate-limit/maintenance): retry on a later tick, bounded by
      // MAX_SEND_ATTEMPTS. Previously ANY non-zero ErrorCode marked
      // the recipient bounced — one Postmark blip mis-recorded a whole
      // 500-chunk as permanently bounced.
      const attempts = (item._attempts || 0) + 1
      if (attempts < MAX_SEND_ATTEMPTS) {
        retriedCount++
        await db.from('campaign_recipients')
          .update({ status: 'queued', attempts, last_error: result.Message || null })
          .eq('id', item._recipientId)
      } else {
        failedCount++
        await db.from('campaign_recipients')
          .update({ status: 'failed', attempts, last_error: result.Message || null })
          .eq('id', item._recipientId)
      }
    } else {
      // Permanent rejection (300 invalid email, 406 inactive recipient,
      // ...): retrying can never succeed. Terminal immediately.
      bouncedCount++
      await db.from('campaign_recipients')
        .update({
          status: 'bounced',
          bounce_type: 'rejected',
          attempts: (item._attempts || 0) + 1,
          last_error: result.Message || null,
        })
        .eq('id', item._recipientId)
    }
  }

  if (sendRecords.length > 0) {
    await db.from('email_sends').insert(sendRecords)
  }

  // Refresh all rollup counters from email_sends so the progress
  // bar reflects reality after this chunk. recalculate_campaign_stats
  // (mig 157) is a single UPDATE with 7 COUNT(*) sub-selects against
  // indexed columns — ~100ms for typical sizes, dominated by
  // sub-selects on email_sends.campaign_id which is indexed. Cheaper
  // than the prior per-row increment approach AND keeps total_sent /
  // total_bounced / etc consistent so the operator-facing campaign
  // editor never shows weird mid-flight deltas.
  await db.rpc('recalculate_campaign_stats', { p_campaign_id: campaignId })
    .then(({ error }) => { if (error) console.error('[campaign-sender] mid-send recalc failed:', error.message) })

  return {
    phase: 'send',
    sent: sentCount,
    bounced: bouncedCount,
    retried: retriedCount,
    failed: failedCount,
    suppressed: suppressed.length,
  }
}

/**
 * CAMPAIGN-REL.2 — return lease-expired 'sending' recipients to the
 * queue (or 'failed' once the attempt cap is spent).
 *
 * A row is stuck when a cron invocation claimed it (queued→sending)
 * and then died before applying the send result — Vercel invocation
 * killed, deploy mid-tick, unhandled throw after the claim. Without
 * this sweep those rows sit in 'sending' forever and the campaign
 * finalises as 'sent' around them.
 *
 * Bulk-updated per attempts-bucket (at most MAX_SEND_ATTEMPTS distinct
 * values) because PostgREST can't express `attempts = attempts + 1`.
 * claimed_at IS NULL rows are pre-mig-392 strays — swept too, so any
 * historically stuck recipients self-heal.
 */
async function reclaimStuckSending(db, campaignId) {
  const cutoff = new Date(Date.now() - SENDING_LEASE_MS).toISOString()
  const { data: stale, error } = await db
    .from('campaign_recipients')
    .select('id, attempts')
    .eq('campaign_id', campaignId)
    .eq('status', 'sending')
    .or(`claimed_at.lt.${cutoff},claimed_at.is.null`)
  if (error) {
    console.error('[campaign-sender] stuck-sending sweep failed:', error.message)
    return
  }
  if (!stale || stale.length === 0) return

  const buckets = new Map() // attempts value → ids
  for (const row of stale) {
    const key = row.attempts || 0
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(row.id)
  }
  for (const [prevAttempts, ids] of buckets) {
    // The claim counted as an attempt — the batch may have reached
    // Postmark before the tick died.
    const attempts = prevAttempts + 1
    const update = attempts < MAX_SEND_ATTEMPTS
      ? { status: 'queued', attempts, last_error: 'send attempt timed out (reclaimed from sending)' }
      : { status: 'failed', attempts, last_error: 'send attempt timed out (reclaimed from sending)' }
    await db.from('campaign_recipients').update(update).in('id', ids)
  }
}
