// WhatsApp inbound consent keywords (STOP / START).
//
// The broadcast footer promises "Reply STOP to Unsubscribe" — this is
// what honours it. The webhook calls applyWhatsappConsentKeyword when an
// inbound TEXT message is an exact keyword match (parseConsentKeyword in
// whatsapp.js). Everything here is best-effort: a consent write must
// never fail the webhook (which always 200s so Meta doesn't disable the
// subscription).
//
// STOP:
//   - contact_preferences.whatsapp_marketing → false (the broadcast /
//     drip / audience gate: buildWhatsAppAudience filters on it)
//   - contacts.wa_status → 'opted_out' (the hard signal every WA send
//     path checks — broadcasts exclude blocked/opted_out)
//   - consent_log row (channel whatsapp_marketing, action opted_out,
//     source whatsapp_keyword) — the audit trail
//   - best-effort acknowledgement text (their keyword just opened the
//     24h window, so a plain text reply is allowed)
// START reverses it (opted_in / wa_status 'active').

import { sendTextMessage } from './whatsapp'

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
 * @returns {Promise<{applied: boolean, action?: string}>}
 */
export async function applyWhatsappConsentKeyword({ db, contact, waPhone, locationId, conversationId, keyword }) {
  if (!contact?.id || !['stop', 'start'].includes(keyword)) return { applied: false }

  const optingOut = keyword === 'stop'
  const action = optingOut ? 'opted_out' : 'opted_in'

  try {
    // 1. The marketing consent flag (source of truth for audiences).
    //    UPSERT by contact_id (same convention as marketing-consent.js):
    //    a contact without a preferences row matched zero rows under the
    //    old .update(), so STOP flipped wa_status but never the flag —
    //    the contact stayed in marketing audiences.
    await db
      .from('contact_preferences')
      .upsert(
        { contact_id: contact.id, whatsapp_marketing: !optingOut, updated_at: new Date().toISOString() },
        { onConflict: 'contact_id' },
      )

    // 2. The hard wa_status signal on the contact row.
    await db
      .from('contacts')
      .update({ wa_status: optingOut ? 'opted_out' : 'active' })
      .eq('id', contact.id)

    // 3. Audit trail.
    await db.from('consent_log').insert({
      contact_id: contact.id,
      channel: 'whatsapp_marketing',
      action,
      source: 'whatsapp_keyword',
    })
  } catch (e) {
    console.error(`[wa-consent] ${keyword} write failed for contact ${contact.id}:`, e?.message || e)
    return { applied: false }
  }

  // 4. Acknowledge — best-effort, and recorded in the thread so the
  //    inbox shows the exchange. Their keyword message opened the 24h
  //    window, so a plain text send is permitted.
  try {
    const ack = optingOut ? ACK_STOP : ACK_START
    const to = waPhone || contact.wa_phone
    if (!to) {
      console.warn(`[wa-consent] no phone for contact ${contact.id} — consent applied but ack skipped`)
    }
    if (to) {
      const result = await sendTextMessage(to, ack, { locationId })
      if (conversationId) {
        await db.from('whatsapp_messages').insert({
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
        await db.from('whatsapp_conversations').update({
          last_message_at: new Date().toISOString(),
          last_message_direction: 'outbound',
          last_message_preview: ack.substring(0, 100),
        }).eq('id', conversationId)
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
  try {
    // Upsert, not update — see applyWhatsappConsentKeyword: a contact
    // with no preferences row must still get the flag flipped.
    await db.from('contact_preferences')
      .upsert(
        { contact_id: contact.id, whatsapp_marketing: !optingOut, updated_at: new Date().toISOString() },
        { onConflict: 'contact_id' },
      )
    await db.from('contacts')
      .update({ wa_status: optingOut ? 'opted_out' : 'active' })
      .eq('id', contact.id)
    await db.from('consent_log').insert({
      contact_id: contact.id,
      channel: 'whatsapp_marketing',
      action: optingOut ? 'opted_out' : 'opted_in',
      source: 'meta_user_preferences',
    })
  } catch (e) {
    console.error(`[wa-consent] user_preferences write failed for contact ${contact.id}:`, e?.message || e)
    return { applied: false, reason: 'write_failed' }
  }
  return { applied: true, action: optingOut ? 'opted_out' : 'opted_in', contactId: contact.id }
}
