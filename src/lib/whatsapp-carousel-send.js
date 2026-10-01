// MIA-CARDS.1 — shared card-set carousel send, used by BOTH the inbox
// send-carousel route (staff-initiated, no source, sent_by = the acting
// staff member since CHECKINSTALL.2) and the agent's
// send_card_set tool (source = AGENT_MESSAGE_SOURCE). One place owns the
// sendMediaCarousel call + the whatsapp_messages thread row so the two
// paths can never drift.
//
// Session message — Meta rejects it outside the 24h window like any other
// session send; that rejection PROPAGATES to the caller (the route maps it
// to a 502, the agent tool returns an error result to Claude). The thread
// row is best-effort: a logging failure never fails a send that Meta
// already accepted.

import { sendMediaCarousel } from '@/lib/whatsapp'

/**
 * Send one curated card set to a WhatsApp conversation and log the thread row.
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {object} args
 * @param {{name:string, body_text?:string, cards:Array}} args.set  a locations.settings.wa_card_sets entry
 * @param {{id:string, contact_id?:string|null, wa_phone:string}} args.conversation
 * @param {string} args.locationId
 * @param {string} [args.source]  whatsapp_messages.source stamp (e.g. 'agent'); omitted = staff send
 * @param {string} [args.sentBy]  the acting staff member's profile id (inbox path) → whatsapp_messages.sent_by
 * @returns {Promise<{messageId?:string}|undefined>} the sendMediaCarousel result
 */
export async function sendCardSetToConversation(db, { set, conversation, locationId, source, sentBy }) {
  const sendResult = await sendMediaCarousel(
    conversation.wa_phone,
    { bodyText: set.body_text || set.name, cards: set.cards },
    // WAREPLYNUMBER.1 (C86) — from the number this thread was written to
    // (staff's send-carousel and Mia's send_card_set both come through here).
    { locationId, replyInConversation: conversation.id }
  )

  // Best-effort thread row — a logging failure never fails the send.
  // wa_message_id lets the carousel's status webhooks match the row.
  try {
    await db.from('whatsapp_messages').insert({
      conversation_id: conversation.id,
      contact_id: conversation.contact_id || null,
      location_id: locationId,
      wa_message_id: sendResult?.messageId || null,
      direction: 'outbound',
      message_type: 'carousel',
      body: `[Card set: ${set.name}]`,
      status: 'sent',
      ...(source ? { source } : {}),
      // CHECKINSTALL.2 (C106 b) — a staff send is a person: Mia's reply path
      // and the check-in runner read sent_by as "a person spoke".
      ...(sentBy ? { sent_by: sentBy } : {}),
      sent_at: new Date().toISOString(),
    })
  } catch (e) { console.error('[wa-carousel] thread row insert failed:', e?.message) }

  return sendResult
}
