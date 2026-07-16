// src/lib/whatsapp-coexistence-ingest.js
//
// WA-COEX.2 — DB ingest for coexistence webhooks. Self-contained so the live
// handleIncomingMessage path stays untouched. Contact rule (Richard): match
// existing contacts ONLY, never create; inherit their marketing prefs
// (we never write consent here). Messages dedup on wa_message_id.

import { normalizeWaPhone } from './whatsapp-coexistence'

/**
 * Match a synced contact to an EXISTING CRM contact by phone. If found,
 * ensure wa_phone linkage (stored without +) and return it. If not found,
 * do nothing (never create). Never touches marketing preferences.
 */
export async function syncContactMatchOnly(db, { phone }) {
  const n = normalizeWaPhone(phone)
  if (!n) return { matched: false, contactId: null }
  const { data: contact } = await db
    .from('contacts')
    .select('id, wa_phone')
    .or(`wa_phone.eq.${n.without},wa_phone.eq.${n.withPlus},phone.eq.${n.without},phone.eq.${n.withPlus}`)
    .limit(1)
    .maybeSingle()
  if (!contact?.id) return { matched: false, contactId: null }
  if (!contact.wa_phone) {
    await db.from('contacts').update({ wa_phone: n.without }).eq('id', contact.id)
  }
  return { matched: true, contactId: contact.id }
}

/**
 * Insert one coexistence message (echo or history), deduped on wa_message_id.
 * Threads to an existing contact if one matches the peer phone (match-only —
 * an unknown peer still gets a conversation/message row so the inbox is
 * complete, but no marketing-eligible contact is created).
 */
export async function ingestCoexistenceMessage(db, { locationId, descriptor }) {
  const { waMessageId, peerPhone, direction, messageType, body, tsSeconds } = descriptor
  if (!waMessageId) return { inserted: false, reason: 'no_id' }

  // Dedup: our own Cloud API sends already store their wa_message_id.
  const { data: dupe } = await db
    .from('whatsapp_messages').select('id').eq('wa_message_id', waMessageId).limit(1).maybeSingle()
  if (dupe?.id) return { inserted: false, reason: 'duplicate' }

  const n = peerPhone ? normalizeWaPhone(peerPhone) : null
  let contactId = null
  if (n) {
    const { data: contact } = await db
      .from('contacts').select('id')
      .or(`wa_phone.eq.${n.without},wa_phone.eq.${n.withPlus},phone.eq.${n.without},phone.eq.${n.withPlus}`)
      .limit(1).maybeSingle()
    contactId = contact?.id || null
  }

  const waPhone = n?.without || peerPhone || 'unknown'
  const { data: existingConv } = await db
    .from('whatsapp_conversations').select('id').eq('location_id', locationId).eq('wa_phone', waPhone).limit(1).maybeSingle()
  let conversationId = existingConv?.id
  if (!conversationId) {
    const { data: newConv } = await db
      .from('whatsapp_conversations')
      .insert({ location_id: locationId, contact_id: contactId, wa_phone: waPhone, status: 'active' })
      .select('id').single()
    conversationId = newConv?.id
  }
  if (!conversationId) return { inserted: false, reason: 'no_conversation' }

  const sentAt = tsSeconds ? new Date(tsSeconds * 1000).toISOString() : new Date().toISOString()
  await db.from('whatsapp_messages').insert({
    conversation_id: conversationId, contact_id: contactId, location_id: locationId,
    wa_message_id: waMessageId, direction, message_type: messageType, body,
    status: direction === 'outbound' ? 'sent' : 'delivered', sent_at: sentAt,
  })
  return { inserted: true, conversationId, contactId }
}
