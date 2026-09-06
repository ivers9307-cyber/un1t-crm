// HOST-CONSENT.1 — Postmark events for HOST campaign mail.
//
// Host sends deliberately write no email_sends row (they are not CRM sends),
// so the CRM processor's lookup-by-MessageID can never resolve them and used
// to drop every one of them as "unmarked" noise. They are identified here by
// the metadata every host send stamps (host-campaign-queue.js):
//   { host_campaign_id, host_id, contact_id }
// — NOT by MessageStream, because streams are per host (event_hosts.postmark_stream_id).
//
// What lands where:
//   Bounce (hard)        contacts.email_status = 'bounced'   — a MAILBOX fact, shared
//   SpamComplaint        email_status = 'complained' + host suppression
//   SubscriptionChange   host suppression (SuppressSending) — NEVER contacts.email_marketing;
//                        reactivation resets email_status only
//   Delivery/Open/Click  acknowledged, parked for HOST-METRICS.1
//
// Contract mirrors processPostmarkEvent: {ok:true} = processed, {ok:false,error}
// = leave the queue row unprocessed so it retries (bounded by MAX_ATTEMPTS).

import { revokeHostConsent } from './host-consent.js'

export function isHostCampaignEvent(body) {
  const id = body?.Metadata?.host_campaign_id
  return typeof id === 'string' && id.length > 0
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {object} body raw Postmark webhook JSON (isHostCampaignEvent(body) === true)
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function processHostCampaignEvent(db, body) {
  const meta = body?.Metadata || {}
  const hostId = meta.host_id
  const contactId = meta.contact_id
  if (!hostId || !contactId) {
    console.warn('[host-campaign webhooks] host event without host_id/contact_id metadata — acknowledged, nothing written', { message: body?.MessageID })
    return { ok: true }
  }

  switch (body.RecordType) {
    case 'Bounce': {
      if (body.Type !== 'HardBounce') return { ok: true }
      const { error } = await db.from('contacts').update({ email_status: 'bounced' }).eq('id', contactId)
      if (error) return { ok: false, error: error.message }
      return { ok: true }
    }
    case 'SpamComplaint': {
      const { error } = await db.from('contacts').update({ email_status: 'complained' }).eq('id', contactId)
      if (error) return { ok: false, error: error.message }
      const r = await revokeHostConsent(db, { hostId, contactId, source: 'postmark_spam_complaint' })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true }
    }
    case 'SubscriptionChange': {
      // Reactivation (SuppressSending=false) is an operator clearing a
      // suppression at Postmark. Consent is restored only by the person, via
      // a re-signup — same rule as the CRM branch (COMMSFIX.C.7).
      if (!body.SuppressSending) {
        // Reactivation: Postmark (or an operator) cleared the suppression, so
        // the mailbox demonstrably works again. Reset the shared mailbox fact
        // this branch wrote; consent is NOT restored (only the person can, via
        // a re-signup). email_suppressed_at is the CRM repeat-bounce stamp and
        // stays the CRM branch's business.
        const { error } = await db.from('contacts')
          .update({ email_status: 'active' })
          .eq('id', contactId)
          .in('email_status', ['bounced', 'complained'])
        if (error) return { ok: false, error: error.message }
        return { ok: true }
      }
      const r = await revokeHostConsent(db, { hostId, contactId, source: 'postmark_one_click_unsubscribe' })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true }
    }
    case 'Delivery':
    case 'Open':
    case 'Click':
      // HOST-METRICS.1 lands per-send tracking here. Acknowledged so the
      // queue row is processed and the event is not logged as noise.
      return { ok: true }
    default:
      console.error(`[host-campaign webhooks] UNHANDLED record_type: ${body.RecordType} (message ${body?.MessageID}) — acknowledged`)
      return { ok: true }
  }
}
