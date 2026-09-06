// Shared host-campaign chunk processing (QSTASH.8).
//
// Extracted from the send-host-campaigns cron's per-campaign tick so the
// QStash worker route (which self-chains one chunk per delivery) and the
// cron share ONE claim/send/finalise implementation — the two consumers
// can run concurrently against host_campaign_sends precisely because
// they go through the same claim CAS: pending→claimed conditioned on
// status still 'pending', so overlapping claimants win DISJOINT rows.
// That CAS is LOAD-BEARING — weaken it and a cron/worker race
// double-sends a recipient.
//
// One call = one chunk: re-verify the sender, CAS-claim ≤BATCH_SIZE
// pending rows for THIS campaign, re-check HOST consent (host_contacts.
// marketing_consent) + per-host suppression + mailbox facts per claimed
// row, send via the host's OWN Postmark stream (event_hosts.
// postmark_stream_id) from the host's verified sender, stamp sent/failed
// per row, refresh sent_count, finalise if drained.
//
// Return contract (what the worker's chaining decision keys on):
//   chunk_sent — this chunk ran; `remaining` = pending rows left. May be
//                0 while ANOTHER consumer holds claimed rows in flight —
//                whoever resolves last finalises; the caller must NOT
//                treat remaining 0 as drained.
//   drained    — the campaign reached a terminal status in THIS call
//                ('sent' / 'failed' — includes the orphaned-host case).
//   halted     — kill switch: sender unverified / sender_email missing.
//                Nothing sent, no error, NO finalise — the campaign
//                deliberately stays 'sending' and resumes via the cron
//                sweeper if UN1T re-verifies the domain.
//   skipped    — campaign not in 'sending' (already finalised, or
//                unknown id).
//   failed     — infrastructure error (any DB statement, incl. the
//                finalise-path count queries — a null count reads as 0
//                and would otherwise mis-finalise a live campaign or
//                clobber sent_count). Retry-safe: rows a crashed attempt
//                left 'claimed' are never re-sent — the cron's stale
//                sweep (CRON-ONLY) takes them terminal 'failed' after
//                its staleness window (no attempts column → terminal is
//                the only never-double-send choice).
//
// `sent`/`failed` counts ride along on chunk_sent/drained for the cron's
// run summary.

import { renderHostCampaignHtml } from './host-campaign-email.js'
import { isEmailable } from './host-contact-list.js'
import { signHostUnsubToken } from './host-unsubscribe.js'
import { sendEmail, applyMergeTags } from './postmark.js'
import { getAppUrl } from './app-url.js'
import { logError } from './log.js'

export const BATCH_SIZE = 50 // send rows claimed per campaign per chunk

/**
 * Process one ≤BATCH_SIZE chunk of a 'sending' host campaign.
 *
 * @param {SupabaseClient} db — service-role client
 * @param {string} campaignId
 * @returns {Promise<{status: 'chunk_sent', remaining: number, sent: number, failed: number}
 *   | {status: 'drained', sent: number, failed: number}
 *   | {status: 'halted', sent: number, failed: number}
 *   | {status: 'skipped'}
 *   | {status: 'failed', error: string}>}
 */
export async function processHostCampaignChunk(db, campaignId) {
  try {
    return await runChunk(db, campaignId)
  } catch (err) {
    return { status: 'failed', error: err?.message || String(err) }
  }
}

async function runChunk(db, campaignId) {
  // Eligibility is part of the fetch: 'sending' only. A finalised (or
  // unknown) campaign is a clean skip for either consumer.
  const { data: campaign, error: campErr } = await db
    .from('host_campaigns')
    .select('id, host_id, subject, body_html, status, email_type, recipient_count, sent_count')
    .eq('id', campaignId)
    .eq('status', 'sending')
    .maybeSingle()
  if (campErr) throw new Error(`campaign load failed: ${campErr.message}`)
  if (!campaign) return { status: 'skipped' }

  // Sender identity + kill switch — re-checked EVERY chunk, so revoking
  // sender_domain_verified stops an in-flight campaign mid-drain.
  const { data: host, error: hostErr } = await db
    .from('event_hosts')
    .select('id, name, email, sender_email, sender_name, sender_domain_verified, reply_to_email, postmark_stream_id')
    .eq('id', campaign.host_id)
    .maybeSingle()
  if (hostErr) throw new Error(`host load failed: ${hostErr.message}`)
  if (!host) {
    // Orphaned campaign (host row gone) — terminal. CAS on 'sending' so a
    // concurrent finaliser is never clobbered.
    await db.from('host_campaigns').update({ status: 'failed' }).eq('id', campaign.id).eq('status', 'sending')
    logError('host-campaigns', 'campaign host missing — marked failed', { campaign_id: campaign.id })
    return { status: 'drained', sent: 0, failed: 0 }
  }
  if (!host.sender_domain_verified || !host.sender_email) {
    // Kill switch: leave the campaign 'sending' but send nothing. It
    // resumes via the cron sweeper if UN1T re-verifies the domain.
    logError('host-campaigns', 'sender not verified — campaign paused', {
      campaign_id: campaign.id, host_id: host.id,
    })
    return { status: 'halted', sent: 0, failed: 0 }
  }

  // HOST-CONSENT.1 — marketing rides the host's OWN Postmark stream. No
  // stream = not set up; halt exactly like the kill switch (resumes on the
  // next sweep once an admin fills postmark_stream_id). Utility is unaffected.
  const isMarketing = campaign.email_type !== 'utility'
  if (isMarketing && !host.postmark_stream_id) {
    logError('host-campaigns', 'host has no postmark_stream_id — marketing campaign paused', {
      campaign_id: campaign.id, host_id: host.id,
    })
    return { status: 'halted', sent: 0, failed: 0 }
  }

  let sent = 0
  let failed = 0

  // Claim a batch: select candidate ids, then CAS pending→claimed. Only the
  // rows the update RETURNS are ours — a concurrent consumer claims disjoint rows.
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
    // Send-time consent re-check (comms invariant; mirrors campaign-sender's
    // post-claim consentOk): rows were enqueued with consent, but a contact
    // can revoke HOST consent (host_contacts.marketing_consent) or unsubscribe
    // via the per-host footer link while the queue drains — the mailbox facts
    // (bounced/complained, email_suppressed_at) still block too. Re-gate every
    // claimed row against live flags before any send. Suppressed-since rows go
    // terminal 'failed' (never sent, never retried — the status check
    // constraint has no 'cancelled').
    const contactIds = claimed.map((r) => r.contact_id)
    const { data: contactRows, error: contactErr } = await db
      .from('contacts')
      .select('id, email, first_name, last_name, name, email_administrative, email_status, email_suppressed_at')
      .in('id', contactIds)
    if (contactErr) throw new Error(`consent re-check failed: ${contactErr.message}`)
    const { data: suppRows, error: suppErr } = await db
      .from('host_email_suppressions')
      .select('contact_id')
      .eq('host_id', campaign.host_id)
      .in('contact_id', contactIds)
    if (suppErr) throw new Error(`suppression re-check failed: ${suppErr.message}`)
    // HOST-CONSENT.1 — the host's consent, off the membership row.
    const { data: memberRows, error: memberErr } = await db
      .from('host_contacts')
      .select('contact_id, marketing_consent')
      .eq('host_id', campaign.host_id)
      .in('contact_id', contactIds)
    if (memberErr) throw new Error(`host consent re-check failed: ${memberErr.message}`)
    const contactById = new Map((contactRows || []).map((c) => [c.id, c]))
    const suppressedIds = new Set((suppRows || []).map((r) => r.contact_id))
    const consentById = new Map((memberRows || []).map((m) => [m.contact_id, m.marketing_consent === true]))
    const sendable = []
    const revokedIds = []
    for (const row of claimed) {
      const ok = isEmailable(contactById.get(row.contact_id) || null, suppressedIds.has(row.contact_id), {
        emailType: isMarketing ? 'marketing' : 'utility',
        hostConsent: consentById.get(row.contact_id) === true,
      })
      if (ok) sendable.push(row)
      else revokedIds.push(row.id)
    }
    if (revokedIds.length) {
      await db.from('host_campaign_sends').update({ status: 'failed' }).in('id', revokedIds)
      failed += revokedIds.length
    }

    const baseUrl = getAppUrl()
    const senderName = host.sender_name || host.name || ''
    const from = `"${senderName.replace(/"/g, "'")}" <${host.sender_email}>`

    for (const row of sendable) {
      // Fresh per-contact unsubscribe token — the footer link is per-host,
      // per-contact (host_email_suppressions), injected by the renderer.
      const unsubscribeUrl =
        `${baseUrl}/unsubscribe/host/${signHostUnsubToken({ hostId: campaign.host_id, contactId: row.contact_id })}`
      // HOST-EMAIL.6 — merge tags, the same engine and syntax as CRM
      // campaigns ({{first_name}} …). Substituted AFTER render/sanitize, on
      // a limited contact shape — hosts get name/email tags only.
      const tagContact = (() => {
        const c = contactById.get(row.contact_id) || {}
        return { first_name: c.first_name || null, last_name: c.last_name || null, name: c.name || null, email: c.email || row.email }
      })()
      const htmlBody = applyMergeTags(renderHostCampaignHtml({
        host,
        subject: campaign.subject,
        bodyHtml: campaign.body_html,
        unsubscribeUrl,
      }), tagContact, { unsubscribe_url: unsubscribeUrl })
      const mergedSubject = applyMergeTags(campaign.subject, tagContact) || campaign.subject
      try {
        await sendEmail({
          to: row.email,
          from,
          // HOST-EMAIL.5 — explicit Reply-To wins; the host login email stays the fallback.
          replyTo: host.reply_to_email || host.email || undefined,
          subject: mergedSubject,
          htmlBody,
          // HOST-CONSENT.1 — utility rides the transactional stream. Marketing
          // keeps the INTERNAL 'broadcast' vocabulary (tracking on, one-click
          // headers attached) while the wire MessageStream is the host's own
          // stream, so Postmark's UN1T suppression list can never refuse it.
          stream: isMarketing ? 'broadcast' : 'outbound',
          postmarkStream: isMarketing ? host.postmark_stream_id : undefined,
          // The same URL the footer carries → List-Unsubscribe / One-Click.
          // Real sends omitted this until HOST-CONSENT.1 (only the test send had it).
          unsubscribeUrl: isMarketing ? unsubscribeUrl : undefined,
          tag: 'host-campaign',
          metadata: { host_campaign_id: campaign.id, host_id: host.id, contact_id: row.contact_id },
        })
        sent += 1
        await db.from('host_campaign_sends')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', row.id)
      } catch (err) {
        failed += 1
        logError('host-campaigns', 'send failed', {
          campaign_id: campaign.id, send_id: row.id, error: err?.message || String(err),
        })
        await db.from('host_campaign_sends').update({ status: 'failed' }).eq('id', row.id)
      }
    }

    // One campaign update per chunk. sent_count is RE-DERIVED from the queue
    // (not read-modify-write incremented) so overlapping consumers that
    // processed disjoint batches can't clobber each other's increment.
    const { count: sentTotal, error: refreshErr } = await db
      .from('host_campaign_sends')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('status', 'sent')
    if (refreshErr) throw new Error(`sent_count refresh failed: ${refreshErr.message}`)
    await db.from('host_campaigns')
      .update({ sent_count: sentTotal || 0 })
      .eq('id', campaign.id)
  }

  // Finalise once nothing is pending AND nothing is claimed (in flight —
  // possibly by another consumer; whoever resolves last finalises). Count
  // errors THROW rather than read as 0 — mis-finalising strands live rows.
  const { count: pendingLeft, error: pendingErr } = await db
    .from('host_campaign_sends')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaign.id)
    .eq('status', 'pending')
  if (pendingErr) throw new Error(`pending count failed: ${pendingErr.message}`)
  if ((pendingLeft || 0) === 0) {
    const { count: claimedLeft, error: claimedErr } = await db
      .from('host_campaign_sends')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('status', 'claimed')
    if (claimedErr) throw new Error(`claimed count failed: ${claimedErr.message}`)
    if ((claimedLeft || 0) === 0) {
      const { count: sentTotal, error: sentErr } = await db
        .from('host_campaign_sends')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaign.id)
        .eq('status', 'sent')
      if (sentErr) throw new Error(`sent count failed: ${sentErr.message}`)
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
      return { status: 'drained', sent, failed }
    }
  }

  return { status: 'chunk_sent', remaining: pendingLeft || 0, sent, failed }
}
