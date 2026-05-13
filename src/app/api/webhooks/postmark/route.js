import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifySharedSecret } from '@/lib/webhook-auth'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { applyMarketingPreferencesBulk } from '@/lib/marketing-consent'

// Force Node.js runtime so node:crypto is available for the timing-safe compare.
export const runtime = 'nodejs'

// POST /api/webhooks/postmark — Handle Postmark delivery webhooks
//
// Authentication: Postmark doesn't natively HMAC-sign webhooks. We require
// a shared-secret token sent in the `X-Webhook-Token` header. Configure in
// Postmark → Servers → [server] → Webhooks → Custom Headers:
//   `X-Webhook-Token: <POSTMARK_WEBHOOK_TOKEN>`
// Each webhook URL on each server needs the header.
//
// Token rotation: set POSTMARK_WEBHOOK_TOKEN_PREVIOUS to the old value while
// you flip every Postmark webhook config to the new one; both are accepted in
// the meantime. Unset PREVIOUS once rotation is complete.
//
// Failure modes:
//   - POSTMARK_WEBHOOK_TOKEN unset → 500 (Postmark retries 5xx for ~24h, so a
//     redeploy with the var set picks up missed events)
//   - X-Webhook-Token header missing or wrong → 403 (Postmark won't retry 4xx,
//     which is what we want for a deliberately-rogue caller)
//
// Events: Delivery, Bounce, SpamComplaint, Open, Click, SubscriptionChange

/**
 * Pure auth-gate predicate, exported so the route test can exercise enforcement
 * without standing up the full Supabase mock. Mirrors the pattern used in
 * src/app/api/webhooks/twilio/status/route.js.
 *
 * @param {object} args
 * @param {string|null} args.headerValue        Value of x-webhook-token header.
 * @param {string|undefined} args.primarySecret POSTMARK_WEBHOOK_TOKEN.
 * @param {string|undefined} args.previousSecret POSTMARK_WEBHOOK_TOKEN_PREVIOUS (rotation).
 * @returns {{ ok: true, matched: 'primary' | 'previous' }
 *          | { ok: false, status: 403 | 500, reason: string }}
 */
export function verifyPostmarkRequest({ headerValue, primarySecret, previousSecret }) {
  if (!primarySecret) {
    // Misconfiguration on our side — fail with 5xx so Postmark retries once
    // we've fixed the env var, instead of losing the event silently.
    return { ok: false, status: 500, reason: 'missing_secret' }
  }
  if (!headerValue) {
    return { ok: false, status: 403, reason: 'missing_header' }
  }

  const primary = verifySharedSecret(headerValue, primarySecret)
  if (primary.ok) return { ok: true, matched: 'primary' }

  if (previousSecret) {
    const previous = verifySharedSecret(headerValue, previousSecret)
    if (previous.ok) return { ok: true, matched: 'previous' }
  }

  return { ok: false, status: 403, reason: 'token_mismatch' }
}

export async function POST(request) {
  const auth = verifyPostmarkRequest({
    headerValue: request.headers.get('x-webhook-token'),
    primarySecret: process.env.POSTMARK_WEBHOOK_TOKEN,
    previousSecret: process.env.POSTMARK_WEBHOOK_TOKEN_PREVIOUS,
  })
  if (!auth.ok) {
    if (auth.reason === 'missing_secret') {
      console.error(
        '[security] POSTMARK_WEBHOOK_TOKEN is not set — refusing Postmark webhook ' +
        'with 500 so Postmark retries once the env var is configured.'
      )
    } else {
      console.warn(`[security] Postmark webhook rejected: ${auth.reason}`)
    }
    return NextResponse.json(
      { success: false, error: auth.reason },
      { status: auth.status }
    )
  }
  if (auth.matched === 'previous') {
    // Loud signal so we notice and finish the rotation rather than leaving the
    // old token live indefinitely.
    console.warn(
      '[security] Postmark webhook accepted via POSTMARK_WEBHOOK_TOKEN_PREVIOUS — ' +
      'finish rotating Postmark custom headers to the new token, then unset PREVIOUS.'
    )
  }

  const body = await request.json()
  const db = createServerClient()

  const messageId = body.MessageID
  if (!messageId) {
    return NextResponse.json({ success: false, error: 'Missing MessageID' }, { status: 400 })
  }

  const recordType = body.RecordType

  // Idempotency (mig 107). One row per (RecordType + MessageID) so
  // a duplicate Delivery / Open / Click / Bounce retry short-
  // circuits before doing the per-record work below.
  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.POSTMARK,
    eventId: `${recordType || 'unknown'}:${messageId}`,
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  try {
    switch (recordType) {
      case 'Delivery': {
        // Update email_sends
        await db.from('email_sends')
          .update({ status: 'delivered', delivered_at: body.DeliveredAt })
          .eq('postmark_message_id', messageId)

        // Update campaign_recipients
        await db.from('campaign_recipients')
          .update({ status: 'delivered', delivered_at: body.DeliveredAt })
          .eq('postmark_message_id', messageId)
          .in('status', ['sent', 'queued'])

        // Increment campaign delivered count
        const { data: send } = await db.from('email_sends')
          .select('campaign_id')
          .eq('postmark_message_id', messageId)
          .single()

        if (send?.campaign_id) {
          await db.rpc('increment_campaign_metric', {
            p_campaign_id: send.campaign_id,
            p_field: 'total_delivered',
          }).catch(() => {
            // Fallback if RPC doesn't exist
            db.from('campaigns')
              .update({ total_delivered: db.raw('total_delivered + 1') })
              .eq('id', send.campaign_id)
          })
        }
        break
      }

      case 'Open': {
        const now = new Date().toISOString()

        // Update email_sends (first open)
        await db.from('email_sends')
          .update({
            status: 'opened',
            opened_at: now,
            open_count: (body.FirstOpen ? 1 : undefined),
          })
          .eq('postmark_message_id', messageId)

        // Increment open count
        const { data: openSend } = await db.from('email_sends')
          .select('id, contact_id, campaign_id, open_count')
          .eq('postmark_message_id', messageId)
          .single()

        if (openSend) {
          await db.from('email_sends')
            .update({ open_count: (openSend.open_count || 0) + 1 })
            .eq('id', openSend.id)

          // Update contact stats (only on first open)
          if (body.FirstOpen) {
            await db.from('contacts')
              .update({ total_emails_opened: db.raw ? undefined : 1 })
              .eq('id', openSend.contact_id)

            // Use raw SQL for increment
            await db.rpc('increment_contact_opens', { p_contact_id: openSend.contact_id }).catch(() => {})
          }

          // Update campaign_recipients
          await db.from('campaign_recipients')
            .update({ status: 'opened', opened_at: now })
            .eq('postmark_message_id', messageId)
            .in('status', ['sent', 'delivered'])

          // Increment campaign open count (first open only)
          if (body.FirstOpen && openSend.campaign_id) {
            await db.from('campaigns')
              .select('total_opened')
              .eq('id', openSend.campaign_id)
              .single()
              .then(({ data }) => {
                if (data) {
                  db.from('campaigns')
                    .update({ total_opened: (data.total_opened || 0) + 1 })
                    .eq('id', openSend.campaign_id)
                }
              })
          }
        }
        break
      }

      case 'Click': {
        const now = new Date().toISOString()
        const clickedUrl = body.OriginalLink

        // Update email_sends
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

          // Update campaign_recipients
          const { data: recipient } = await db.from('campaign_recipients')
            .select('clicked_links')
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

          // Increment campaign click count
          if (clickSend.campaign_id) {
            await db.from('campaigns')
              .select('total_clicked')
              .eq('id', clickSend.campaign_id)
              .single()
              .then(({ data }) => {
                if (data) {
                  db.from('campaigns')
                    .update({ total_clicked: (data.total_clicked || 0) + 1 })
                    .eq('id', clickSend.campaign_id)
                }
              })
          }

          // Update contact stats
          await db.rpc('increment_contact_clicks', { p_contact_id: clickSend.contact_id }).catch(() => {})
        }
        break
      }

      case 'Bounce': {
        const now = new Date().toISOString()
        const bounceType = body.Type === 'HardBounce' ? 'hard' : body.Type === 'SoftBounce' ? 'soft' : 'transient'

        // Update email_sends
        await db.from('email_sends')
          .update({ status: 'bounced', bounced_at: now, bounce_type: bounceType })
          .eq('postmark_message_id', messageId)

        // Update campaign_recipients
        await db.from('campaign_recipients')
          .update({ status: 'bounced', bounced_at: now, bounce_type: bounceType })
          .eq('postmark_message_id', messageId)

        // Hard bounce — mark contact as bounced AND auto-unsubscribe
        // them from email marketing.
        //
        // UNSUB.2 — operator request: "implement an automation to
        // unsubscribe everybody who returns bounced". Previously this
        // handler only set contacts.email_status='bounced', which the
        // campaign prefilter already excludes. But the contact's
        // email_marketing pref stayed true, which (a) meant the
        // audience builder still showed them as opted-in, (b) any
        // future query that filters on email_marketing alone (no
        // email_status check) would still target them, and (c) the
        // recipient's consent record had no trail for the bounce.
        //
        // Flipping email_marketing=false via applyMarketingPreferencesBulk
        // gets us upsert semantics, the consent_log audit entry
        // (source='postmark_hard_bounce'), ClassPass safety (PAYG
        // contacts skip — they're managed separately by the auto-
        // unsubscribe-classpass cron from mig 151), and the
        // email_status reputation guard that won't trample our
        // freshly-set 'bounced' value.
        //
        // We only do this on HARD bounce. Soft + transient bounces
        // come through here as bounceType='soft'/'transient' and
        // get logged at the send/recipient level only, so transient
        // mailbox-full / greylist-style failures don't burn the
        // contact's opt-in state.
        if (bounceType === 'hard') {
          const { data: bounceSend } = await db.from('email_sends')
            .select('contact_id, campaign_id')
            .eq('postmark_message_id', messageId)
            .single()

          if (bounceSend) {
            await db.from('contacts')
              .update({ email_status: 'bounced' })
              .eq('id', bounceSend.contact_id)

            // Auto-unsubscribe. Failures here shouldn't break the
            // bounce ack (Postmark would retry the webhook and we'd
            // double-update email_status), so we log and continue.
            const unsubResult = await applyMarketingPreferencesBulk(db, {
              contactId: bounceSend.contact_id,
              prefs: { email_marketing: false },
              source: 'postmark_hard_bounce',
            })
            if (!unsubResult.ok) {
              console.error('[postmark webhook] auto-unsubscribe on hard bounce failed:', unsubResult.error, { contactId: bounceSend.contact_id })
            }

            if (bounceSend.campaign_id) {
              await db.from('campaigns')
                .select('total_bounced')
                .eq('id', bounceSend.campaign_id)
                .single()
                .then(({ data }) => {
                  if (data) {
                    db.from('campaigns')
                      .update({ total_bounced: (data.total_bounced || 0) + 1 })
                      .eq('id', bounceSend.campaign_id)
                  }
                })
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

        // Mark contact as complained and auto-unsubscribe from marketing
        const { data: complaintSend } = await db.from('email_sends')
          .select('contact_id, campaign_id')
          .eq('postmark_message_id', messageId)
          .single()

        if (complaintSend) {
          await db.from('contacts')
            .update({ email_status: 'complained' })
            .eq('id', complaintSend.contact_id)

          // UNSUB.2 — same auto-unsubscribe path as HardBounce, but
          // with source='postmark_spam_complaint'. Replaces an
          // earlier inline implementation that (1) used .update()
          // instead of upsert, so contacts with no preferences row
          // silently stayed opted-in, and (2) wrote 'opted_out' to
          // consent_log.action where the canonical value used
          // everywhere else is 'opt_out'.
          const unsubResult = await applyMarketingPreferencesBulk(db, {
            contactId: complaintSend.contact_id,
            prefs: { email_marketing: false },
            source: 'postmark_spam_complaint',
          })
          if (!unsubResult.ok) {
            console.error('[postmark webhook] auto-unsubscribe on spam complaint failed:', unsubResult.error, { contactId: complaintSend.contact_id })
          }

          if (complaintSend.campaign_id) {
            await db.from('campaigns')
              .select('total_complained')
              .eq('id', complaintSend.campaign_id)
              .single()
              .then(({ data }) => {
                if (data) {
                  db.from('campaigns')
                    .update({ total_complained: (data.total_complained || 0) + 1 })
                    .eq('id', complaintSend.campaign_id)
                }
              })
          }
        }
        break
      }

      case 'SubscriptionChange': {
        // Postmark's built-in unsubscribe handling
        if (body.SuppressSending) {
          const { data: unsubSend } = await db.from('email_sends')
            .select('contact_id')
            .eq('postmark_message_id', messageId)
            .single()

          if (unsubSend) {
            await db.from('contact_preferences')
              .update({ email_marketing: false })
              .eq('contact_id', unsubSend.contact_id)

            await db.from('consent_log').insert({
              contact_id: unsubSend.contact_id,
              channel: 'email_marketing',
              action: 'opted_out',
              source: 'one_click_unsubscribe',
            })
          }
        }
        break
      }

      default:
        if (process.env.NODE_ENV !== 'production') {
          console.log(`Unhandled Postmark webhook type: ${recordType}`)
        }
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Postmark webhook error:', error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}
