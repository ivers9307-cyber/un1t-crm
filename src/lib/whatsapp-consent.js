// WhatsApp inbound consent keywords (STOP / START).
//
// The broadcast footer promises "Reply STOP to Unsubscribe" — this is
// what honours it. The webhook calls applyWhatsappConsentKeyword when an
// inbound TEXT message is an exact keyword match (parseConsentKeyword in
// whatsapp.js). Nothing here throws: a consent write must never fail the
// webhook (which always 200s so Meta doesn't disable the subscription). That
// is NOT the same as best-effort — the two authoritative writes report
// `applied: false` on failure so the caller can log it and no acknowledgement
// is sent for a change that did not happen.
//
// STOP:
//   - contact_preferences.whatsapp_marketing → false (the broadcast /
//     drip / audience gate: buildWhatsAppAudience filters on it)
//   - contacts.wa_status → 'opted_out' (the hard signal every WA send
//     path checks — broadcasts exclude blocked/opted_out)
//   - consent_log row (channel whatsapp_marketing, action opt_out,
//     source whatsapp_keyword) — the audit trail
//   - best-effort acknowledgement text (their keyword just opened the
//     24h window, so a plain text reply is allowed)
// START reverses it (opt_in / wa_status 'active').
//
// GAPS-P6 — the consent_log rows written here used to say 'opted_out' /
// 'opted_in', which is the `contacts.wa_status` vocabulary, not the
// `consent_log.action` one. 83 real opt-outs were invisible to every report
// filtering `action = 'opt_out'`. The two columns are adjacent in this file
// and mean different things: wa_status KEEPS 'opted_out' (it is correct
// there), the log action moves to the canonical CONSENT_ACTIONS.

import { sendTextMessage } from './whatsapp'
import { consentActionFor } from './consent-actions'

const ACK_STOP =
  "You've been unsubscribed from WhatsApp marketing messages. Reply START at any time to opt back in."
const ACK_START =
  "You're opted back in to WhatsApp messages. Reply STOP at any time to unsubscribe."

/**
 * Apply a parsed consent keyword for a contact. Never throws.
 *
 * @param {object} args
 * @param {object} args.db            service-role client
 * @param {{id: string, wa_phone?: string}} args.contact  must have id
 * @param {string|null} [args.waPhone]  the sender's number — pass this
 *   explicitly from the webhook (its contact lookup is a minimal
 *   `select('id, location_id')`, so contact.wa_phone is usually absent;
 *   relying on it silently skipped the ack on the first live STOP).
 * @param {string|null} args.locationId
 * @param {string|null} args.conversationId  thread to attribute the ack to
 * @param {'stop'|'start'} args.keyword
 * @returns {Promise<{applied: boolean, action?: string, reason?: string}>}
 *   `applied: false` means the consent change did NOT land and no
 *   acknowledgement was sent — the caller should log it, loudly.
 */
export async function applyWhatsappConsentKeyword({ db, contact, waPhone, locationId, conversationId, keyword }) {
  if (!contact?.id || !['stop', 'start'].includes(keyword)) return { applied: false }

  const optingOut = keyword === 'stop'
  const action = consentActionFor(!optingOut)

  // BAREWRITE.1 (follow-up) — these three writes were BARE awaits inside a
  // try/catch, which is the most dangerous member of the class because it
  // READS as handled: supabase builders resolve with `{ data, error }` instead
  // of throwing, so that catch could never fire for any of them. The function
  // then returned `applied: true` unconditionally and sent the customer "You've
  // been unsubscribed from WhatsApp marketing messages" — while they were still
  // in every marketing audience. The step-1 comment below already records an
  // earlier incarnation of exactly this bug.
  //
  // The two AUTHORITATIVE legs (the audience flag and wa_status) now fail the
  // function: never tell someone they are unsubscribed when the flag did not
  // flip. The audit-trail insert does not — losing an audit line is not a
  // reason to leave a real opt-out unacknowledged — but it is logged.

  // 1. The marketing consent flag (source of truth for audiences).
  //    UPSERT by contact_id (same convention as marketing-consent.js):
  //    a contact without a preferences row matched zero rows under the
  //    old .update(), so STOP flipped wa_status but never the flag —
  //    the contact stayed in marketing audiences.
  const { error: prefError } = await db
    .from('contact_preferences')
    .upsert(
      { contact_id: contact.id, whatsapp_marketing: !optingOut, updated_at: new Date().toISOString() },
      { onConflict: 'contact_id' },
    )
  if (prefError) {
    console.error(`[wa-consent] ${keyword} preference write FAILED for contact ${contact.id} — not acknowledging, the contact is still in marketing audiences:`, prefError.message)
    return { applied: false, reason: 'preference_write_failed' }
  }

  // 2. The hard wa_status signal on the contact row.
  const { error: statusError } = await db
    .from('contacts')
    .update({ wa_status: optingOut ? 'opted_out' : 'active' })
    .eq('id', contact.id)
  if (statusError) {
    console.error(`[wa-consent] ${keyword} wa_status write FAILED for contact ${contact.id} — not acknowledging:`, statusError.message)
    return { applied: false, reason: 'status_write_failed' }
  }

  // 3. Audit trail. Best-effort ON PURPOSE: the consent change above has
  //    already landed, so refusing to acknowledge over a lost log line would
  //    leave the customer un-answered on a change that did take effect.
  const { error: logError } = await db.from('consent_log').insert({
    contact_id: contact.id,
    channel: 'whatsapp_marketing',
    action,
    source: 'whatsapp_keyword',
  })
  if (logError) {
    console.error(`[wa-consent] ${keyword} applied but the consent_log row was lost for contact ${contact.id}:`, logError.message)
  }

  // 4. Acknowledge — best-effort, and recorded in the thread so the
  //    inbox shows the exchange. Their keyword message opened the 24h
  //    window, so a plain text send is permitted.
  //
  //    THIS try/catch is real: sendTextMessage genuinely throws. The two
  //    supabase writes inside it do not, so they carry their own error checks
  //    — losing them costs an inbox line, not the consent change, so they log
  //    rather than fail.
  try {
    const ack = optingOut ? ACK_STOP : ACK_START
    const to = waPhone || contact.wa_phone
    if (!to) {
      console.warn(`[wa-consent] no phone for contact ${contact.id} — consent applied but ack skipped`)
    }
    if (to) {
      const result = await sendTextMessage(to, ack, { locationId })
      if (conversationId) {
        const { error: msgError } = await db.from('whatsapp_messages').insert({
          conversation_id: conversationId,
          contact_id: contact.id,
          location_id: locationId,
          wa_message_id: result.messageId,
          direction: 'outbound',
          message_type: 'text',
          body: ack,
          status: 'sent',
          sent_at: new Date().toISOString(),
        })
        if (msgError) console.error(`[wa-consent] ack sent but not recorded in the thread for contact ${contact.id}:`, msgError.message)
        const { error: convError } = await db.from('whatsapp_conversations').update({
          last_message_at: new Date().toISOString(),
          last_message_direction: 'outbound',
          last_message_preview: ack.substring(0, 100),
        }).eq('id', conversationId)
        if (convError) console.error(`[wa-consent] ack sent but the conversation preview was not updated for contact ${contact.id}:`, convError.message)
      }
    }
  } catch (e) {
    // The consent change stands even if the ack couldn't send.
    console.warn(`[wa-consent] ack send failed for contact ${contact.id}:`, e?.message || e)
  }

  return { applied: true, action }
}

/**
 * Meta's user_preferences webhook — the in-app "stop marketing messages" /
 * "resume" control (a SEPARATE signal from STOP/START keywords). Applies the
 * same three writes as the keyword path (preference flag + wa_status +
 * consent_log) but sends NO ack: Meta shows its own confirmation UX.
 * pref = { wa_id, category, value: 'stop'|'resume' }.
 */
export async function applyMetaUserPreference(db, pref = {}) {
  if (pref.category && pref.category !== 'marketing_messages') return { applied: false, reason: 'unknown_category' }
  if (!['stop', 'resume'].includes(pref.value)) return { applied: false, reason: 'unknown_value' }
  const waId = String(pref.wa_id || '').replace(/\D/g, '')
  if (!waId) return { applied: false, reason: 'no_wa_id' }

  const { data: contacts } = await db.from('contacts')
    .select('id')
    .or(`wa_phone.eq.${waId},wa_phone.eq.+${waId},phone.eq.${waId},phone.eq.+${waId}`)
    .limit(1)
  const contact = contacts?.[0]
  if (!contact) return { applied: false, reason: 'no_contact' }

  const optingOut = pref.value === 'stop'
  // Same three writes, same BAREWRITE.1 correction as the keyword path above:
  // the try/catch that used to wrap them could not fire for a supabase result,
  // so `applied: true` was unconditional.
  // Upsert, not update — see applyWhatsappConsentKeyword: a contact
  // with no preferences row must still get the flag flipped.
  const { error: prefError } = await db.from('contact_preferences')
    .upsert(
      { contact_id: contact.id, whatsapp_marketing: !optingOut, updated_at: new Date().toISOString() },
      { onConflict: 'contact_id' },
    )
  if (prefError) {
    console.error(`[wa-consent] user_preferences preference write FAILED for contact ${contact.id}:`, prefError.message)
    return { applied: false, reason: 'write_failed' }
  }
  const { error: statusError } = await db.from('contacts')
    .update({ wa_status: optingOut ? 'opted_out' : 'active' })
    .eq('id', contact.id)
  if (statusError) {
    console.error(`[wa-consent] user_preferences wa_status write FAILED for contact ${contact.id}:`, statusError.message)
    return { applied: false, reason: 'write_failed' }
  }
  const { error: logError } = await db.from('consent_log').insert({
    contact_id: contact.id,
    channel: 'whatsapp_marketing',
    action: consentActionFor(!optingOut),
    source: 'meta_user_preferences',
  })
  if (logError) {
    console.error(`[wa-consent] user_preferences applied but the consent_log row was lost for contact ${contact.id}:`, logError.message)
  }
  return { applied: true, action: consentActionFor(!optingOut), contactId: contact.id }
}
