// Postmark webhook event processor — extracted from the inline
// route handler in CAMPAIGN.13 so the webhook endpoint can stay
// fast (auth + queue insert + return) and a cron drains the queue
// asynchronously. Same per-event semantics as before; this file
// just owns the per-event work.
//
// Each call processes ONE Postmark event payload. Idempotency is
// handled upstream: the webhook handler dedups by (RecordType +
// MessageID) via recordWebhookEvent before queueing. If a duplicate
// somehow slips through, the email_sends.update().in(['sent',
// 'delivered']) status guards keep most of this code a no-op on
// the second run. Counters are atomic +1 via mig 157's
// increment_campaign_metric RPC.

import { applyMarketingPreferencesBulk } from './marketing-consent.js'
import { findBcaSubmissionByMessageId, recordBcaPostmarkEvent } from './bca-events.js'

/**
 * Process a single Postmark webhook payload.
 *
 * @param {SupabaseClient} db — service-role client
 * @param {object} body — raw Postmark webhook JSON
 * @returns {Promise<{ ok: boolean, error?: string, deduped?: boolean }>}
 */
export async function processPostmarkEvent(db, body) {
  const messageId = body?.MessageID
  if (!messageId) {
    return { ok: false, error: 'missing_message_id' }
  }
  const recordType = body.RecordType

  // BCA submission events ride on the same Postmark webhook firehose
  // but tagged 'bca-submit'. They never match an email_sends or
  // campaign_recipients row, so the existing handlers below silently
  // no-op on them. Route them here first; if the message id maps to
  // a car_bca_submissions row, handle it and return — the rest of
  // the switch is for marketing / transactional / campaign events.
  if (body?.Tag === 'bca-submit') {
    const bca = await findBcaSubmissionByMessageId(db, messageId)
    if (bca) {
      const r = await recordBcaPostmarkEvent(db, bca.id, body)
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }
    // Tag says bca-submit but no row matches — could be a webhook
    // for a deleted submission. Fall through to no-op rather than
    // erroring (the dedup gate has already done its job).
    return { ok: true }
  }

  try {
    switch (recordType) {
      case 'Delivery': {
        await db.from('email_sends')
          .update({ status: 'delivered', delivered_at: body.DeliveredAt })
          .eq('postmark_message_id', messageId)

        await db.from('campaign_recipients')
          .update({ status: 'delivered', delivered_at: body.DeliveredAt })
          .eq('postmark_message_id', messageId)
          .in('status', ['sent', 'queued'])

        const { data: send } = await db.from('email_sends')
          .select('campaign_id')
          .eq('postmark_message_id', messageId)
          .single()

        if (send?.campaign_id) {
          const { error } = await db.rpc('increment_campaign_metric', {
            p_campaign_id: send.campaign_id,
            p_field: 'total_delivered',
          })
          if (error) console.error('[postmark processor] total_delivered increment failed:', error.message)
        }
        break
      }

      case 'Open': {
        const now = new Date().toISOString()

        await db.from('email_sends')
          .update({ status: 'opened', opened_at: now })
          .eq('postmark_message_id', messageId)

        const { data: openSend } = await db.from('email_sends')
          .select('id, contact_id, campaign_id, open_count')
          .eq('postmark_message_id', messageId)
          .single()

        if (openSend) {
          await db.from('email_sends')
            .update({ open_count: (openSend.open_count || 0) + 1 })
            .eq('id', openSend.id)

          if (body.FirstOpen) {
            // supabase-js builders are thenables, not Promises — they
            // have .then but no .catch. Wrap in try/catch around await.
            try { await db.rpc('increment_contact_opens', { p_contact_id: openSend.contact_id }) } catch {}
          }

          await db.from('campaign_recipients')
            .update({ status: 'opened', opened_at: now })
            .eq('postmark_message_id', messageId)
            .in('status', ['sent', 'delivered'])

          if (body.FirstOpen && openSend.campaign_id) {
            const { error } = await db.rpc('increment_campaign_metric', {
              p_campaign_id: openSend.campaign_id,
              p_field: 'total_opened',
            })
            if (error) console.error('[postmark processor] total_opened increment failed:', error.message)
          }
        }
        break
      }

      case 'Click': {
        const now = new Date().toISOString()
        const clickedUrl = body.OriginalLink

        const { data: clickSend } = await db.from('email_sends')
          .select('id, contact_id, campaign_id, click_count')
          .eq('postmark_message_id', messageId)
          .single()

        if (clickSend) {
          await db.from('email_sends')
            .update({
              status: 'clicked',
              clicked_at: now,
              click_count: (clickSend.click_count || 0) + 1,
            })
            .eq('id', clickSend.id)

          const { data: recipient } = await db.from('campaign_recipients')
            .select('clicked_links, clicked_at')
            .eq('postmark_message_id', messageId)
            .single()

          if (recipient) {
            const links = recipient.clicked_links || []
            links.push({ url: clickedUrl, clicked_at: now })

            await db.from('campaign_recipients')
              .update({
                status: 'clicked',
                clicked_at: recipient.clicked_at || now,
                clicked_links: links,
              })
              .eq('postmark_message_id', messageId)
          }

          if (clickSend.campaign_id) {
            const { error } = await db.rpc('increment_campaign_metric', {
              p_campaign_id: clickSend.campaign_id,
              p_field: 'total_clicked',
            })
            if (error) console.error('[postmark processor] total_clicked increment failed:', error.message)
          }

          try { await db.rpc('increment_contact_clicks', { p_contact_id: clickSend.contact_id }) } catch {}
        }
        break
      }

      case 'Bounce': {
        const now = new Date().toISOString()
        const bounceType = body.Type === 'HardBounce' ? 'hard' : body.Type === 'SoftBounce' ? 'soft' : 'transient'

        await db.from('email_sends')
          .update({ status: 'bounced', bounced_at: now, bounce_type: bounceType })
          .eq('postmark_message_id', messageId)

        await db.from('campaign_recipients')
          .update({ status: 'bounced', bounced_at: now, bounce_type: bounceType })
          .eq('postmark_message_id', messageId)

        // Hard bounce only — mark contact + auto-unsubscribe (UNSUB.2).
        if (bounceType === 'hard') {
          const { data: bounceSend } = await db.from('email_sends')
            .select('contact_id, campaign_id')
            .eq('postmark_message_id', messageId)
            .single()

          if (bounceSend) {
            await db.from('contacts')
              .update({ email_status: 'bounced' })
              .eq('id', bounceSend.contact_id)

            const unsubResult = await applyMarketingPreferencesBulk(db, {
              contactId: bounceSend.contact_id,
              prefs: { email_marketing: false },
              source: 'postmark_hard_bounce',
            })
            if (!unsubResult.ok) {
              console.error('[postmark processor] auto-unsubscribe on hard bounce failed:', unsubResult.error, { contactId: bounceSend.contact_id })
            }

            if (bounceSend.campaign_id) {
              const { error: incErr } = await db.rpc('increment_campaign_metric', {
                p_campaign_id: bounceSend.campaign_id,
                p_field: 'total_bounced',
              })
              if (incErr) console.error('[postmark processor] total_bounced increment failed:', incErr.message)
            }
          }
        }
        break
      }

      case 'SpamComplaint': {
        const now = new Date().toISOString()

        await db.from('email_sends')
          .update({ status: 'complained', complained_at: now })
          .eq('postmark_message_id', messageId)

        await db.from('campaign_recipients')
          .update({ status: 'complained', complained_at: now })
          .eq('postmark_message_id', messageId)

        const { data: complaintSend } = await db.from('email_sends')
          .select('contact_id, campaign_id')
          .eq('postmark_message_id', messageId)
          .single()

        if (complaintSend) {
          await db.from('contacts')
            .update({ email_status: 'complained' })
            .eq('id', complaintSend.contact_id)

          const unsubResult = await applyMarketingPreferencesBulk(db, {
            contactId: complaintSend.contact_id,
            prefs: { email_marketing: false },
            source: 'postmark_spam_complaint',
          })
          if (!unsubResult.ok) {
            console.error('[postmark processor] auto-unsubscribe on spam complaint failed:', unsubResult.error, { contactId: complaintSend.contact_id })
          }

          if (complaintSend.campaign_id) {
            const { error: incErr } = await db.rpc('increment_campaign_metric', {
              p_campaign_id: complaintSend.campaign_id,
              p_field: 'total_complained',
            })
            if (incErr) console.error('[postmark processor] total_complained increment failed:', incErr.message)
          }
        }
        break
      }

      case 'SubscriptionChange': {
        if (body.SuppressSending) {
          const { data: unsubSend } = await db.from('email_sends')
            .select('contact_id')
            .eq('postmark_message_id', messageId)
            .single()

          if (unsubSend) {
            // UNSUB.2 follow-up — route through applyMarketingPreferencesBulk
            // for the same reasons as HardBounce / SpamComplaint: upsert
            // semantics, audit log via consent_log, ClassPass guard.
            const unsubResult = await applyMarketingPreferencesBulk(db, {
              contactId: unsubSend.contact_id,
              prefs: { email_marketing: false },
              source: 'postmark_one_click_unsubscribe',
            })
            if (!unsubResult.ok) {
              console.error('[postmark processor] auto-unsubscribe on one-click failed:', unsubResult.error)
            }
          }
        }
        break
      }

      default:
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[postmark processor] unhandled record_type: ${recordType}`)
        }
    }
    return { ok: true }
  } catch (error) {
    console.error('[postmark processor] error:', error)
    return { ok: false, error: error?.message || String(error) }
  }
}
