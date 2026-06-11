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
 * @param {string|null} args.locationId
 * @param {string|null} args.conversationId  thread to attribute the ack to
 * @param {'stop'|'start'} args.keyword
 * @returns {Promise<{applied: boolean, action?: string}>}
 */
export async function applyWhatsappConsentKeyword({ db, contact, locationId, conversationId, keyword }) {
  if (!contact?.id || !['stop', 'start'].includes(keyword)) return { applied: false }

  const optingOut = keyword === 'stop'
  const action = optingOut ? 'opted_out' : 'opted_in'

  try {
    // 1. The marketing consent flag (source of truth for audiences).
    await db
      .from('contact_preferences')
      .update({ whatsapp_marketing: !optingOut })
      .eq('contact_id', contact.id)

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
    const to = contact.wa_phone
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
