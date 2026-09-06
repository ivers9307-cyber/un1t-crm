// HOST-CONSENT.1 — Postmark events for HOST campaign mail.
//
// Host sends deliberately write no email_sends row (they are not CRM sends),
// so the CRM processor's lookup-by-MessageID can never resolve them and used
// to drop every one of them as "unmarked" noise. They are identified here by
// the metadata every host send stamps (host-campaign-queue.js):
//   { host_campaign_id, host_id, contact_id }
// — NOT by MessageStream, because streams are per host (event_hosts.postmark_stream_id).
// A test send stamps { host_campaign_id, host_id, test_send: '1' } (no
// contact_id) — expected traffic, acknowledged silently, no row lookup.
//
// What lands where:
//   Bounce (hard)        contacts.email_status = 'bounced'   — a MAILBOX fact, shared
//                         + host_campaign_sends.bounced_at/bounce_type ('hard') on the row
//   Bounce (soft/other)  host_campaign_sends.bounced_at/bounce_type ('soft'|'transient') only
//   SpamComplaint        email_status = 'complained' + host suppression
//                         + host_campaign_sends.complained_at
//   SubscriptionChange   host suppression (SuppressSending) — NEVER contacts.email_marketing;
//                        + host_campaign_sends.unsubscribed_at
//                        reactivation resets email_status only
//   Delivery/Open/Click  host_campaign_sends.delivered_at/opened_at/clicked_at
//                        (Click also stamps opened_at — a click implies an open).
//                        The Postmark server (CRM.UN1T) has "First Open Only"
//                        ON, so Postmark sends exactly ONE Open webhook per
//                        message — open_count can only ever be 0 or 1 from
//                        webhooks, so it is a "has opened" FLAG, not a count.
//                        It is bumped only when the guarded opened_at stamp
//                        actually changed a row (first open, by definition —
//                        a queue replay after a stale-claim reclaim must not
//                        double it). click_count has no such setting on
//                        either end — it is a real count, bumped
//                        unconditionally. Both via bump_host_send_counter RPC.
//
// Every event (mig 590, HOST-METRICS.1) is resolved to its
// host_campaign_sends row by (campaign_id, contact_id) — that pair is UNIQUE
// on the table. The postmark_message_id stamp is the one write here that is
// unconditional across every RecordType (guarded only on the column still
// being null, not on which case runs below) — a zero-GUID placeholder is
// never stamped. A test send never reaches this lookup at all (it returns
// above on Metadata.test_send). A missing row here (deleted campaign, race
// with the insert) is not an error: the mailbox/consent writes above still
// run where applicable, the per-send stamps are just skipped.
//
// Contract mirrors processPostmarkEvent: {ok:true} = processed, {ok:false,error}
// = leave the queue row unprocessed so it retries (bounded by MAX_ATTEMPTS).

import { revokeHostConsent } from './host-consent.js'

export function isHostCampaignEvent(body) {
  const id = body?.Metadata?.host_campaign_id
  return typeof id === 'string' && id.length > 0
}

async function findSendRow(db, campaignId, contactId) {
  const { data, error } = await db
    .from('host_campaign_sends')
    .select('id, postmark_message_id')
    .eq('campaign_id', campaignId)
    .eq('contact_id', contactId)
    .maybeSingle()
  if (error) return { row: null, error: error.message }
  return { row: data || null, error: null }
}

// First write wins: guarded on the column still being null. `changed` tells
// the caller whether THIS call is the one that flipped it — needed by the
// Open case, where a queue replay after a stale-claim reclaim must not
// double-bump open_count.
async function stampOnce(db, rowId, column, value) {
  const { data, error } = await db
    .from('host_campaign_sends')
    .update({ [column]: value })
    .eq('id', rowId)
    .is(column, null)
    .select('id')
  return { error: error ? error.message : null, changed: Array.isArray(data) && data.length > 0 }
}

const ZERO_GUID = '00000000-0000-0000-0000-000000000000'
// Postmark's MessageID is a GUID; the queue's own placeholder default is the
// all-zero one, and it must never be stamped as if it were real.
const isValidMessageId = (id) => typeof id === 'string' && id.length > 0 && id !== ZERO_GUID

async function stampBounce(db, rowId, at, type) {
  const { error } = await db
    .from('host_campaign_sends')
    .update({ bounced_at: at, bounce_type: type })
    .eq('id', rowId)
    .is('bounced_at', null)
  return error ? error.message : null
}

// Best-effort counter bump — never fatal to the event, logged if it fails.
async function bump(db, rowId, field) {
  try {
    const { error } = await db.rpc('bump_host_send_counter', { p_send_id: rowId, p_field: field })
    if (error) console.error(`[host-campaign webhooks] bump_host_send_counter(${field}) failed for send ${rowId}: ${error.message}`)
  } catch (e) {
    console.error(`[host-campaign webhooks] bump_host_send_counter(${field}) threw for send ${rowId}`, e)
  }
}

const at = (v) => (typeof v === 'string' && v) || new Date().toISOString()

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {object} body raw Postmark webhook JSON (isHostCampaignEvent(body) === true)
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function processHostCampaignEvent(db, body) {
  const meta = body?.Metadata || {}

  // Test sends carry no contact_id by design — expected traffic, not a
  // metadata defect, so no warn and no row lookup.
  if (meta.test_send === '1') return { ok: true }

  const hostId = meta.host_id
  const contactId = meta.contact_id
  if (!hostId || !contactId) {
    console.warn('[host-campaign webhooks] host event without host_id/contact_id metadata — acknowledged, nothing written', { message: body?.MessageID })
    return { ok: true }
  }

  const { row, error: findError } = await findSendRow(db, meta.host_campaign_id, contactId)
  if (findError) return { ok: false, error: findError }

  if (!row) {
    console.info('[host-campaign webhooks] no send row for event', {
      record_type: body.RecordType,
      campaign_id: meta.host_campaign_id,
      contact_id: contactId,
    })
  }

  if (row && !row.postmark_message_id && isValidMessageId(body.MessageID)) {
    const { error: stampErr } = await stampOnce(db, row.id, 'postmark_message_id', body.MessageID)
    if (stampErr) return { ok: false, error: stampErr }
  }

  switch (body.RecordType) {
    case 'Bounce': {
      const type = body.Type === 'HardBounce' ? 'hard' : body.Type === 'SoftBounce' ? 'soft' : 'transient'
      if (row) {
        const bounceErr = await stampBounce(db, row.id, at(body.BouncedAt), type)
        if (bounceErr) return { ok: false, error: bounceErr }
      }
      if (body.Type !== 'HardBounce') return { ok: true }
      const { error } = await db.from('contacts').update({ email_status: 'bounced' }).eq('id', contactId)
      if (error) return { ok: false, error: error.message }
      return { ok: true }
    }
    case 'SpamComplaint': {
      if (row) {
        const { error: stampErr } = await stampOnce(db, row.id, 'complained_at', at(body.BouncedAt))
        if (stampErr) return { ok: false, error: stampErr }
      }
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
      if (row) {
        const { error: stampErr } = await stampOnce(db, row.id, 'unsubscribed_at', at(body.ChangedAt))
        if (stampErr) return { ok: false, error: stampErr }
      }
      const r = await revokeHostConsent(db, { hostId, contactId, source: 'postmark_one_click_unsubscribe' })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true }
    }
    case 'Delivery': {
      if (row) {
        const { error: stampErr } = await stampOnce(db, row.id, 'delivered_at', at(body.DeliveredAt))
        if (stampErr) return { ok: false, error: stampErr }
      }
      return { ok: true }
    }
    case 'Open': {
      if (row) {
        const { error: stampErr, changed } = await stampOnce(db, row.id, 'opened_at', at(body.ReceivedAt))
        if (stampErr) return { ok: false, error: stampErr }
        // First Open Only means Postmark sends exactly one Open per message,
        // so a genuine first open is exactly the case where the guarded
        // stamp above changed a row. A queue replay after a stale-claim
        // reclaim resends the same event; the stamp then matches zero rows
        // and must not double-bump the counter.
        if (changed) await bump(db, row.id, 'open_count')
      }
      return { ok: true }
    }
    case 'Click': {
      if (row) {
        const { error: clickErr } = await stampOnce(db, row.id, 'clicked_at', at(body.ReceivedAt))
        if (clickErr) return { ok: false, error: clickErr }
        // A click implies an open — some clients (or link-scanning proxies)
        // fire Click without a preceding Open.
        const { error: openErr } = await stampOnce(db, row.id, 'opened_at', at(body.ReceivedAt))
        if (openErr) return { ok: false, error: openErr }
        // Clicks have no "first only" setting — click_count is a true count,
        // bumped unconditionally.
        await bump(db, row.id, 'click_count')
      }
      return { ok: true }
    }
    default:
      console.error(`[host-campaign webhooks] UNHANDLED record_type: ${body.RecordType} (message ${body?.MessageID}) — acknowledged`)
      return { ok: true }
  }
}
