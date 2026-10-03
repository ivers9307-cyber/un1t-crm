// src/lib/whatsapp-coexistence-ingest.js
//
// WA-COEX.2 — DB ingest for coexistence webhooks. Self-contained so the live
// handleIncomingMessage path stays untouched. Contact rule (Richard): match
// existing contacts ONLY, never create; inherit their marketing prefs
// (we never write consent here). Messages dedup on wa_message_id.

import { normalizeWaPhone } from './whatsapp-coexistence'
import { manualTakeoverPatch } from './agent/core'
import { WA_APP_ECHO_SOURCE } from './whatsapp-staff-sources'
import { logError } from './log'

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
 *
 * C106 CHECKINRISKS.1 (d) — an ECHO (descriptor.origin 'echo') is a reply a
 * person typed in the studio's linked WhatsApp Business phone app. It is
 * stored as source 'app_echo' (no sent_by: there is no CRM user behind it),
 * which every staff reader counts as staff (whatsapp-staff-sources.js), and
 * it takes the thread over from Mia exactly as an inbox send does
 * (manualTakeoverPatch; she re-arms after handoff_cooldown_hours). History
 * rows (origin 'history', or no origin) keep the column default and take
 * nothing over: they are weeks old, and created_at is the IMPORT time, so a
 * staff tag would read as "staff just spoke" in every created_at-ordered
 * reader.
 */
export async function ingestCoexistenceMessage(db, { locationId, descriptor }) {
  const { waMessageId, peerPhone, direction, messageType, body, tsSeconds } = descriptor
  if (!waMessageId) return { inserted: false, reason: 'no_id' }
  if (direction !== 'inbound' && direction !== 'outbound') return { inserted: false, reason: 'bad_direction' }

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
    const { data: newConv, error: convErr } = await db
      .from('whatsapp_conversations')
      .insert({ location_id: locationId, contact_id: contactId, wa_phone: waPhone, status: 'active' })
      .select('id').single()
    if (convErr) {
      // Lost the (location_id, wa_phone) unique race — re-read the winner.
      const { data: raced } = await db
        .from('whatsapp_conversations').select('id')
        .eq('location_id', locationId).eq('wa_phone', waPhone).limit(1).maybeSingle()
      conversationId = raced?.id
    } else {
      conversationId = newConv?.id
    }
  }
  if (!conversationId) return { inserted: false, reason: 'no_conversation' }

  const isEcho = descriptor.origin === 'echo' && direction === 'outbound'
  const sentAt = tsSeconds ? new Date(tsSeconds * 1000).toISOString() : new Date().toISOString()
  const { error: msgErr } = await db.from('whatsapp_messages').insert({
    conversation_id: conversationId, contact_id: contactId, location_id: locationId,
    wa_message_id: waMessageId, direction, message_type: messageType, body,
    status: direction === 'outbound' ? 'sent' : 'delivered', sent_at: sentAt,
    ...(isEcho ? { source: WA_APP_ECHO_SOURCE } : {}),
  })
  if (msgErr) return { inserted: false, reason: msgErr.message }
  if (!isEcho) return { inserted: true, conversationId, contactId }

  // The staff member answered from the phone: Mia stops auto-replying in
  // this thread, the same take-over the inbox send route applies. The message
  // is already stored, so a failed write is logged and reported, never thrown
  // (the webhook must still 200, and a retry would dedup on wa_message_id).
  const { error: takeoverErr } = await db.from('whatsapp_conversations')
    .update(manualTakeoverPatch())
    .eq('id', conversationId)
  if (takeoverErr) {
    logError('wa-coexistence', 'phone-app echo stored but the take-over write failed (Mia not paused)', {
      conversationId, locationId, waMessageId, err: takeoverErr.message,
    })
    return { inserted: true, conversationId, contactId, takeoverFailed: true }
  }
  return { inserted: true, conversationId, contactId }
}
