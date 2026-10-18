// A STAFF send's WhatsApp conversation (the contact composer and the
// cancellation-form send).
//
// WAORGNUMBER.4 (spec R3) — a staff send from the contact page goes for the
// contact's HOME studio (contact.location_id), and its thread files there
// through getOrCreateConversation(db, contact, contact.location_id) (the
// routes call it). The old getOrCreateContactConversation picked the contact's
// most recent thread at ANY studio, which could pair a thread at one studio
// with another studio's number once numbers are shared; it is gone. These two
// helpers are what is left of it: the phone a send goes to, and the thread
// fields the routes read.

const SEND_CONVERSATION_COLUMNS = 'id, window_expires_at, location_id, agent_handed_off_at'

/** The contact's WhatsApp number as Meta wants it (no leading '+'), or null. */
export function contactWaPhone(contact) {
  const phone = contact?.wa_phone || contact?.phone
  if (!phone) return null
  return phone.startsWith('+') ? phone.slice(1) : phone
}

/**
 * The conversation getOrCreateConversation returned, with the fields a staff
 * send reads. Returns { ok:true, conversation } or { ok:false, status, error }.
 */
export async function loadSendConversation(db, conversationId) {
  if (!conversationId) return { ok: false, status: 500, error: 'Could not open a conversation' }
  const { data, error } = await db.from('whatsapp_conversations')
    .select(SEND_CONVERSATION_COLUMNS)
    .eq('id', conversationId)
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: 'Could not read the conversation' }
  if (!data) return { ok: false, status: 500, error: 'Could not open a conversation' }
  return { ok: true, conversation: data }
}
