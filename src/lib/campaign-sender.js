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
//        d. SELECT first CHUNK_SIZE campaign_recipients WHERE
//           status='queued' for this campaign.
//        e. Send them via Postmark batch.
//        f. UPDATE each to 'sent' / 'bounced' + log to email_sends.
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

import { buildAudienceQueryAsync, applyMergeTags, buildUnsubscribeUrl, appendUnsubscribeFooter, sendBatch, consentFieldForStream } from './postmark.js'
import { getAppUrl } from './app-url.js'

const CHUNK_SIZE = 500             // recipients per cron tick per campaign
const AUDIENCE_PAGE_SIZE = 1000    // audience load page (CAMPAIGN.11)
const RECIPIENT_INSERT_CHUNK = 1000

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

    // Bulk insert recipients in chunks.
    const recipientRows = contacts.map(c => ({
      campaign_id: campaignId,
      contact_id: c.id,
      status: 'queued',
    }))
    for (let i = 0; i < recipientRows.length; i += RECIPIENT_INSERT_CHUNK) {
      const chunk = recipientRows.slice(i, i + RECIPIENT_INSERT_CHUNK)
      const { error } = await db.from('campaign_recipients').insert(chunk)
      if (error) return { phase: 'populate', error: `recipient insert failed: ${error.message}` }
    }

    await db.from('campaigns').update({
      status: 'sending',
      total_recipients: contacts.length,
      send_started_at: new Date().toISOString(),
    }).eq('id', campaignId)

    return { phase: 'populate', sent: 0 }
  }

  // Phase 2 — process one CHUNK_SIZE batch of queued recipients.
  // Join contacts inline so we have email + name + preferences for
  // the merge tags + unsubscribe URL without a second round-trip.
  const { data: candidateRows, error: queuedErr } = await db
    .from('campaign_recipients')
    .select(`
      id,
      contact_id,
      contact:contacts!inner(
        id, email, first_name, last_name, name, phone, pipeline_stage_slug,
        email_status, email_marketing, email_administrative, glofox_passcode,
        contact_preferences(unsubscribe_token)
      )
    `)
    .eq('campaign_id', campaignId)
    .eq('status', 'queued')
    .order('id', { ascending: true })
    .limit(CHUNK_SIZE)

  if (queuedErr) return { phase: 'send', error: `queued fetch failed: ${queuedErr.message}` }

  if (!candidateRows || candidateRows.length === 0) {
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
    .update({ status: 'sending' })
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

    return {
      to: contact.email,
      subject: applyMergeTags(campaign.subject, contact),
      htmlBody: personalizedHtml,
      from: campaign.from_name
        ? `${campaign.from_name} <${campaign.from_email || process.env.POSTMARK_FROM_EMAIL}>`
        : undefined,
      replyTo: campaign.reply_to,
      stream,
      tag: `campaign-${campaignId}`,
      metadata: {
        campaign_id: campaignId,
        contact_id: contact.id,
      },
      unsubscribeUrl,
      _recipientId: row.id,
      _contactId: contact.id,
    }
  })

  const results = await sendBatch(emailBatch)

  // Apply results.
  let sentCount = 0
  let bouncedCount = 0
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
        subject: campaign.subject,
        from_email: campaign.from_email || process.env.POSTMARK_FROM_EMAIL,
        to_email: item.to,
        postmark_message_id: result.MessageID,
        postmark_stream: stream,
        status: 'sent',
      })
    } else {
      bouncedCount++
      await db.from('campaign_recipients')
        .update({ status: 'bounced', bounce_type: 'rejected' })
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

  return { phase: 'send', sent: sentCount, bounced: bouncedCount, suppressed: suppressed.length }
}
