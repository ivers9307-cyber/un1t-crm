// MIA-CARDS.1 — shared card-set carousel send, used by BOTH the inbox
// send-carousel route (staff-initiated, no source) and the agent's
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
 * @returns {Promise<{messageId?:string}|undefined>} the sendMediaCarousel result
 */
export async function sendCardSetToConversation(db, { set, conversation, locationId, source }) {
  const sendResult = await sendMediaCarousel(
    conversation.wa_phone,
    { bodyText: set.body_text || set.name, cards: set.cards },
    { locationId }
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
      sent_at: new Date().toISOString(),
    })
  } catch (e) { console.error('[wa-carousel] thread row insert failed:', e?.message) }

  return sendResult
}
