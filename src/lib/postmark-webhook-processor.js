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
import { recordTicketMessageDelivery } from './email-delivery-status.js'
import { escapeLikePattern } from './like-escape.js'

/**
 * COMMSFIX.C.7 — which contact a SubscriptionChange reactivation is about.
 *
 * Message-bound events resolve through email_sends like every other handler.
 * A Postmark-SIDE reactivation is not tied to a delivered message, so it
 * arrives carrying the zero GUID and matches nothing — those carry `Recipient`
 * instead. (Before COMMSFIX.C.2 every zero-GUID SubscriptionChange also shared
 * one dedup key, so only the first ever got this far at all.)
 *
 * `.ilike` with escapeLikePattern, not `.eq`: contacts are stored mixed-case,
 * and an unescaped pattern would let `_`/`%` — both legal email characters —
 * match a DIFFERENT contact (CLAUDE.md, the inbound-email misfiling class).
 */
async function resolveReactivationContact(db, body, messageId) {
  const { data: send } = await db.from('email_sends')
    .select('contact_id')
    .eq('postmark_message_id', messageId)
    .single()
  if (send?.contact_id) return send.contact_id

  const recipient = typeof body?.Recipient === 'string' ? body.Recipient.trim() : ''
  if (!recipient) return null

  const { data: contact } = await db.from('contacts')
    .select('id')
    .ilike('email', escapeLikePattern(recipient))
    .maybeSingle()
  return contact?.id || null
}

/**
 * COMMSFIX.C.3 — call a best-effort counter RPC and LOG any failure.
 *
 * Best-effort means "never fail the event", not "never tell anyone". Both
 * failure channels have to be covered: supabase-js builders are thenables with
 * no .catch (so the await needs a try/catch), and PostgREST/Postgres errors
 * come back in the RESULT object rather than as a throw.
 */
async function reportRpc(db, fn, args) {
  try {
    const { error } = await db.rpc(fn, args)
    if (error) console.error(`[postmark processor] ${fn} failed:`, error.message)
  } catch (err) {
    console.error(`[postmark processor] ${fn} threw:`, err?.message || err)
  }
}

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

  // EMAIL-DELIVERY.1 — stamp the outcome onto the OUTBOUND TICKET MESSAGE, if
  // this event belongs to one. Placed before the switch, not inside three of
  // its cases, for two reasons: the three record types get provably identical
  // treatment, and the thread marker still lands even if a campaign counter RPC
  // below blows up and sends the event round for a retry (the write is
  // idempotent under the severity lattice, so the retry re-runs it harmlessly).
  //
  // Everything about it is a no-op unless the MessageID matches a ticket
  // message we sent: a campaign, invoice or booking-confirmation event simply
  // matches zero rows. It NEVER fails the event — see the header of
  // email-delivery-status.js — so nothing here can turn a bounce into a
  // dead-letter, which is the hole POSTMARK-DLQ.1 closed and this must not
  // reopen from the other side. The suppression and auto-unsubscribe behaviour
  // below is untouched and remains the authority on what a bounce DOES.
  await recordTicketMessageDelivery(db, body)

  try {
    switch (recordType) {
      case 'Delivery': {
        // COMMSFIX.C.1 — the increment rides the TRANSITION, not the event.
        //
        // `.is('delivered_at', null)` makes the UPDATE itself the guard: the
        // returned rows are exactly the ones this event moved from NULL to a
        // timestamp, so a replayed Delivery (now possible — COMMSFIX.C.2
        // narrows the webhook dedup key) matches zero rows and increments
        // nothing. Two concurrent workers race on the row lock and only one
        // sees a row back. Reading campaign_id off the returned row also drops
        // the follow-up SELECT the old code needed.
        const { data: deliveredSends } = await db.from('email_sends')
          .update({ status: 'delivered', delivered_at: body.DeliveredAt })
          .eq('postmark_message_id', messageId)
          .is('delivered_at', null)
          .select('id, campaign_id, contact_id')

        // 'sending' belongs here: the chunk claim flips queued→sending before
        // the batch goes out, and the Delivery webhook regularly beats the
        // per-recipient 'sent' update, so those rows were being skipped.
        const { data: stampedRecipients } = await db.from('campaign_recipients')
          .update({ status: 'delivered', delivered_at: body.DeliveredAt })
          .eq('postmark_message_id', messageId)
          .in('status', ['sent', 'queued', 'sending'])
          .select('id')

        // COMMSFIX.C.1b — …and when even that matches nothing, resolve the
        // recipient through the send row. C.1 moved the email_sends insert
        // ahead of the loop that stamps campaign_recipients.postmark_message_id,
        // so a fast Delivery webhook now lands in a window where the send row
        // exists but no recipient row carries the id yet. Keying on the send's
        // (campaign_id, contact_id) — UNIQUE on campaign_recipients — addresses
        // exactly the right row, so the recipient-level stamp isn't lost to the
        // very reordering that fixed the campaign counter.
        if (!(stampedRecipients || []).length) {
          const viaSend = (deliveredSends || []).find(s => s?.campaign_id && s?.contact_id)
          if (viaSend) {
            await db.from('campaign_recipients')
              .update({ status: 'delivered', delivered_at: body.DeliveredAt })
              .eq('campaign_id', viaSend.campaign_id)
              .eq('contact_id', viaSend.contact_id)
              .in('status', ['sent', 'queued', 'sending'])
          }
        }

        // COMMSFIX.C.1c — C.1 shrinks the race to a single INSERT, but a
        // Delivery that still beats it is lost FOREVER: the webhook dedup key
        // rejects Postmark's retry at the door and nothing else ever sets
        // delivered_at, so recalculate_campaign_stats keeps reporting the gap
        // as fact. Silence is exactly how this defect survived months of
        // campaigns, so the one case that means real loss — no email_sends row
        // exists for the message AT ALL — is logged. Zero updated rows is the
        // normal replay path (the row is already delivered), so the cheap
        // count probe only runs on that branch and only to tell the two apart.
        if (!(deliveredSends || []).length) {
          const { count: knownSends } = await db.from('email_sends')
            .select('id', { count: 'exact', head: true })
            .eq('postmark_message_id', messageId)
          if (!knownSends) {
            console.error(
              `[postmark processor] Delivery for unknown message ${messageId} — no email_sends row; ` +
              'delivery NOT recorded and the retry will be deduped. Suspect the send-loop insert race.'
            )
          }
        }

        const campaignId = (deliveredSends || []).find(s => s?.campaign_id)?.campaign_id
        if (campaignId) {
          const { error } = await db.rpc('increment_campaign_metric', {
            p_campaign_id: campaignId,
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
          .select('id, contact_id, campaign_id')
          .eq('postmark_message_id', messageId)
          .single()

        if (openSend) {
          // EMAIL-HYGIENE.1 — an open is engagement: clear the hygiene
          // suppression stamp (contacts.email_suppressed_at, mig 395) so
          // the contact rejoins the marketing audience. Guarded on the
          // stamp being non-null so the common case is a filtered no-op.
          await db.from('contacts')
            .update({ email_suppressed_at: null })
            .eq('id', openSend.contact_id)
            .not('email_suppressed_at', 'is', null)

          // Atomic open counter (best-effort) — replaces the read-modify-write.
          try { await db.rpc('increment_email_send_opens', { p_send_id: openSend.id }) } catch {}

          // GAPS-P1 (mig 511) — engagement RECENCY, the signal the inactivity
          // cron and both win-back templates have been driving against a
          // column that did not exist.
          //
          // Deliberately OUTSIDE the FirstOpen gate below, and deliberately
          // reusing `now` — the same instant written to email_sends.opened_at
          // three statements up. mig 511 backfilled the column as
          // max(email_sends.opened_at) per contact, and opened_at is rewritten
          // on EVERY Open, so anything else here (a second clock read, a
          // FirstOpen gate, body.ReceivedAt) makes the stamp a different
          // quantity from the backfill and the two drift apart silently.
          //
          // The never-move-backwards guard lives in the RPC, not here: it is
          // atomic against a concurrent worker replaying an older event, where
          // a read-modify-write in JS would be the same lost-update race
          // COMMSFIX.F.2 removed from clicked_links. A regressed stamp would
          // make "opened in the last 30 days" quietly wrong.
          await reportRpc(db, 'stamp_contact_email_open', {
            p_contact_id: openSend.contact_id,
            p_at: now,
          })

          if (body.FirstOpen) {
            // supabase-js builders are thenables, not Promises — they
            // have .then but no .catch. Wrap in try/catch around await.
            // COMMSFIX.C.3 — still best-effort, but no longer SILENT. This
            // call spent months hitting a function that did not exist (mig 508
            // creates it) and nothing anywhere said so: the catch swallowed
            // throws, and supabase-js returns PostgREST errors in the result
            // rather than throwing, so the error object went straight in the bin.
            await reportRpc(db, 'increment_contact_opens', { p_contact_id: openSend.contact_id })
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
          .select('id, contact_id, campaign_id, location_id')
          .eq('postmark_message_id', messageId)
          .single()

        if (clickSend) {
          // EMAIL-HYGIENE.1 — a click is engagement: clear the hygiene
          // suppression stamp (same guarded no-op as the Open handler).
          await db.from('contacts')
            .update({ email_suppressed_at: null })
            .eq('id', clickSend.contact_id)
            .not('email_suppressed_at', 'is', null)

          await db.from('email_sends')
            .update({ status: 'clicked', clicked_at: now })
            .eq('id', clickSend.id)
          // Atomic click counter (best-effort) — replaces the read-modify-write.
          try { await db.rpc('increment_email_send_clicks', { p_send_id: clickSend.id }) } catch {}

          // COMMSFIX.F.2 — one row per click event (mig 510). This replaces a
          // select → push → update on campaign_recipients.clicked_links: a
          // lost-update race that only ever looked safe because the webhook
          // dedup key collapsed repeat Clicks on a message into one event.
          // COMMSFIX.C narrows that key, so repeats now arrive and two
          // concurrent Clicks would overwrite each other's array. An INSERT
          // has nothing to lose, and "which link won" becomes a GROUP BY.
          //
          // Transactional sends carry no campaign_id and are skipped without
          // comment — campaign_link_clicks is a campaign report. A campaign
          // send with no location_id IS anomalous (campaigns.location_id is
          // nullable, the click row's is not), so it is logged rather than
          // fired as an insert guaranteed to violate the constraint.
          if (clickSend.campaign_id && clickSend.location_id && clickedUrl) {
            const { error: linkErr } = await db.from('campaign_link_clicks').insert({
              campaign_id: clickSend.campaign_id,
              contact_id: clickSend.contact_id,
              location_id: clickSend.location_id,
              url: clickedUrl,
              clicked_at: now,
              postmark_message_id: messageId,
            })
            // Never swallowed: a silently-dropped click is the failure mode
            // this whole programme keeps finding. Logged, not thrown — a lost
            // report row is not worth dead-lettering the webhook event.
            if (linkErr) {
              console.error('[postmark processor] campaign_link_clicks insert failed:', linkErr.message)
            }
          } else if (clickSend.campaign_id) {
            console.error('[postmark processor] campaign_link_clicks insert skipped — campaign send is missing location_id or url:', {
              sendId: clickSend.id,
              campaignId: clickSend.campaign_id,
              hasUrl: Boolean(clickedUrl),
            })
          }

          // The recipient row keeps status/clicked_at — the resend targeting
          // and the Recipients tab read them. Both are stamped BLIND: two
          // writes, zero reads, so nothing here can lose an update either.
          // clicked_at is guarded to the first click server-side; a later
          // click matches no row and is a filtered no-op.
          await db.from('campaign_recipients')
            .update({ clicked_at: now })
            .eq('postmark_message_id', messageId)
            .is('clicked_at', null)

          await db.from('campaign_recipients')
            .update({ status: 'clicked' })
            .eq('postmark_message_id', messageId)

          if (clickSend.campaign_id) {
            const { error } = await db.rpc('increment_campaign_metric', {
              p_campaign_id: clickSend.campaign_id,
              p_field: 'total_clicked',
            })
            if (error) console.error('[postmark processor] total_clicked increment failed:', error.message)
          }

          // COMMSFIX.C.3 — see the Open handler; best-effort but logged.
          await reportRpc(db, 'increment_contact_clicks', { p_contact_id: clickSend.contact_id })

          // GAPS-P1 (mig 511) — click recency, mirroring the Open handler.
          // Same `now` that email_sends.clicked_at got, so the column stays
          // equal to max(email_sends.clicked_at) — what the backfill computed.
          // Monotonic guard inside the RPC.
          await reportRpc(db, 'stamp_contact_email_click', {
            p_contact_id: clickSend.contact_id,
            p_at: now,
          })
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
        if (!body.SuppressSending) {
          // COMMSFIX.C.7 — REACTIVATION. An operator clearing a suppression in
          // Postmark (or Postmark clearing one itself) was silently ignored,
          // so our mirror of that block stayed stuck on forever: a contact
          // stamped email_status='bounced' by an old hard bounce, or carrying
          // the engagement-hygiene email_suppressed_at stamp, never came back
          // even though the address demonstrably works again.
          //
          // What this DOES NOT do is re-opt anyone into marketing. Postmark's
          // suppression is a DELIVERY block; consent is a separate family, and
          // flipping email_marketing back on off a provider event would be
          // opting somebody in without their say-so. Marketing consent is
          // restored only by the person themselves, via the preference centre.
          const contactId = await resolveReactivationContact(db, body, messageId)
          if (contactId) {
            // Same guarded no-op shape as the Open/Click hygiene clear.
            await db.from('contacts')
              .update({ email_suppressed_at: null })
              .eq('id', contactId)
              .not('email_suppressed_at', 'is', null)

            // email_status is reputation-only (LOCCOMMS.5), and a Postmark
            // reactivation is precisely a reputation reset. Guarded so an
            // 'active' row is never rewritten.
            await db.from('contacts')
              .update({ email_status: 'active' })
              .eq('id', contactId)
              .in('email_status', ['bounced', 'complained'])
          }
          break
        }
        {
          const { data: unsubSend } = await db.from('email_sends')
            .select('contact_id, campaign_id')
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

            // COMMS-AUDIT 2026-07-10 — attribute the unsubscribe to the
            // campaign whose email carried the unsubscribe link. This was
            // never wired: total_unsubscribed sat at 0 on every campaign
            // while the other counters incremented. Only count when the
            // flag actually FLIPPED (changed includes email_marketing) so
            // webhook replays and already-unsubscribed contacts don't
            // inflate the metric — same reason recalculate_campaign_stats
            // deliberately leaves this counter alone (mig 157).
            if (unsubResult.ok && unsubResult.changed?.includes('email_marketing') && unsubSend.campaign_id) {
              const { error: incErr } = await db.rpc('increment_campaign_metric', {
                p_campaign_id: unsubSend.campaign_id,
                p_field: 'total_unsubscribed',
              })
              if (incErr) console.error('[postmark processor] total_unsubscribed increment failed:', incErr.message)
            }
          }
        }
        break
      }

      default:
        // COMMSFIX.C.7 — LOUD IN PROD. This was gated on NODE_ENV !==
        // 'production', so in prod the queue row was marked processed with
        // zero trace: no log line, no counter, no dead-letter row. If Postmark
        // ships a new RecordType, every event of it "succeeds" while doing
        // nothing and there is no artefact to discover it from. Still returns
        // ok — the webhook contract is 200 for unrecognised events (CLAUDE.md),
        // so a provider never auto-disables the hook over one.
        console.error(`[postmark processor] UNHANDLED record_type: ${recordType} (message ${messageId}) — event acknowledged but nothing was done with it`)
    }
    return { ok: true }
  } catch (error) {
    console.error('[postmark processor] error:', error)
    return { ok: false, error: error?.message || String(error) }
  }
}
