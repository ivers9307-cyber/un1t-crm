// VOICEREPLY.1 — a voice reply WhatsApp accepted and then failed to deliver
// is resent once as text (spec §5, "Accepted, then failed").
//
// Meta answers a media send at once and fetches the audio afterwards, so an
// unfetchable or undecodable file shows up later as a `failed` status. The
// webhook's status handler calls this for an agent voice-reply row
// (voice_kind set). The resend is claimed with a compare-and-set on
// voice_fallback_sent_at, so a repeated webhook never sends twice. A refusal
// (no number switched on, a send error) is logged and staff are pushed, as for
// any reply Mia could not deliver. Never throws.

import { sendTextMessage } from '@/lib/whatsapp'
import { isWhatsAppNumberMissing } from '@/lib/whatsapp-number-missing'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'
import { logWarn, logError } from '@/lib/log'
import { AGENT_MESSAGE_SOURCE } from '@/lib/agent/core'

export async function resendVoiceReplyAsText(db, msg, deps = {}) {
  const sendText = deps.sendText || ((to, text, opts) => sendTextMessage(to, text, opts))
  const push = deps.push || ((locationId, payload) => sendPushToRolesAtLocation(locationId, MANAGER_ROLES, payload))
  const ids = { messageId: msg?.id || null, conversationId: msg?.conversation_id || null }
  const tellStaff = async (reason) => {
    logWarn('wa-voice-reply', 'undelivered voice reply not resent', { ...ids, reason })
    try {
      await push(msg.location_id, {
        title: 'WhatsApp · voice reply not delivered',
        body: "A voice reply from Mia didn't reach the customer and the text copy couldn't be sent. Check the thread and reply.",
        category: 'whatsapp',
        data: { type: 'whatsapp_agent_handoff', conversation_id: msg.conversation_id },
      })
    } catch (err) {
      logError('wa-voice-reply', 'undelivered voice reply push failed', { ...ids, error: err?.message || String(err) })
    }
    return { resent: false, reason }
  }

  try {
    if (!msg?.id || !msg.voice_kind || msg.message_type !== 'audio' || !String(msg.body || '').trim()) return { resent: false, reason: 'not_a_voice_reply' }

    const { data: claimed, error: claimError } = await db.from('whatsapp_messages')
      .update({ voice_fallback_sent_at: new Date().toISOString() })
      .eq('id', msg.id)
      .is('voice_fallback_sent_at', null)
      .select('id')
    if (claimError) {
      logError('wa-voice-reply', 'voice fallback claim failed', { ...ids, error: claimError.message })
      return { resent: false, reason: 'claim_failed' }
    }
    if (!Array.isArray(claimed) || claimed.length === 0) return { resent: false, reason: 'already_sent' }

    const { data: conv } = await db.from('whatsapp_conversations')
      .select('wa_phone')
      .eq('id', msg.conversation_id)
      .maybeSingle()
    if (!conv?.wa_phone) return await tellStaff('no_phone')

    let sent
    try {
      sent = await sendText(conv.wa_phone, msg.body, { locationId: msg.location_id, replyInConversation: msg.conversation_id })
    } catch (err) {
      return await tellStaff(isWhatsAppNumberMissing(err) ? 'no_number' : 'send_failed')
    }

    const { error: insertError } = await db.from('whatsapp_messages').insert({
      conversation_id: msg.conversation_id,
      contact_id: msg.contact_id || null,
      location_id: msg.location_id,
      wa_message_id: sent?.messageId || null,
      direction: 'outbound',
      message_type: 'text',
      body: msg.body,
      status: 'sent',
      source: AGENT_MESSAGE_SOURCE,
      sent_at: new Date().toISOString(),
    })
    if (insertError) logError('wa-voice-reply', 'voice fallback text not recorded', { ...ids, error: insertError.message })
    return { resent: true }
  } catch (err) {
    logError('wa-voice-reply', 'voice fallback threw', { ...ids, error: err?.message || String(err) })
    return { resent: false, reason: 'threw' }
  }
}
