// AGENT-HANDS.1 — agent-originated thread messages OUTSIDE the live
// reply loop. First user: the booking confirmation sent into the
// originating WhatsApp/Instagram thread when a staffer approves a
// drafted class booking (the approval executes the booking; this
// closes the loop with the customer so staff touch one button total).
//
// Mirrors the operator send routes' mechanics: WA respects the 24h
// window (requests are fresh so it's almost always open — a closed
// window returns sent:false and the staffer follows up manually);
// IG resolves the location connection. Both record the outbound
// message row so the thread history is complete. Fail-soft
// throughout — a send hiccup never breaks the approval.

/** Friendly booking-confirmed text. Pure — unit-tested. */
export function buildBookingConfirmationText({ className, classTime } = {}) {
  const what = [className, classTime].filter(Boolean).join(' — ')
  return what
    ? `Good news — you're booked in for ${what}. See you there! 💪`
    : "Good news — you're booked in. See you there! 💪"
}

/** AGENT-CANCEL.1 — in-thread confirmation once an approved cancellation executes. */
export function buildCancellationConfirmationText({ className, classTime } = {}) {
  const what = [className, classTime].filter(Boolean).join(' — ')
  return what
    ? `All sorted — your booking for ${what} has been cancelled. Hope to see you at another class soon!`
    : 'All sorted — your booking has been cancelled. Hope to see you at another class soon!'
}

/**
 * Send `text` into an agent conversation thread.
 * @returns {{ sent: boolean, reason?: string }}
 */
export async function sendAgentThreadMessage(db, { channel, conversationId, text }) {
  if (!conversationId || !text) return { sent: false, reason: 'missing_args' }
  try {
    if (channel === 'whatsapp') {
      const { data: conversation } = await db.from('whatsapp_conversations')
        .select('id, location_id, wa_phone, window_expires_at, contact_id, contacts!contact_id ( id, wa_phone )')
        .eq('id', conversationId)
        .maybeSingle()
      if (!conversation) return { sent: false, reason: 'conversation_not_found' }
      const phone = conversation.contacts?.wa_phone || conversation.wa_phone
      if (!phone) return { sent: false, reason: 'no_phone' }

      const { sendTextMessage, isWindowOpen } = await import('@/lib/whatsapp')
      if (!isWindowOpen(conversation)) return { sent: false, reason: 'window_closed' }

      const result = await sendTextMessage(phone, text, { locationId: conversation.location_id })
      // source='agent' (allowed since mig 259) so the agent sees this
      // confirmation in its own history and it counts toward the caps.
      const { error: insertError } = await db.from('whatsapp_messages').insert({
        conversation_id: conversationId,
        contact_id: conversation.contact_id || null,
        location_id: conversation.location_id,
        wa_message_id: result?.messageId || null,
        direction: 'outbound',
        message_type: 'text',
        body: text,
        status: 'sent',
        source: 'agent',
        sent_at: new Date().toISOString(),
      })
      if (insertError) console.error('[agent][notify] failed to record WhatsApp confirmation (history will be incomplete):', insertError.message)
      return { sent: true }
    }

    if (channel === 'instagram') {
      const { data: conversation } = await db.from('instagram_conversations')
        .select('id, location_id, ig_user_id, contact_id')
        .eq('id', conversationId)
        .maybeSingle()
      if (!conversation) return { sent: false, reason: 'conversation_not_found' }
      if (!conversation.ig_user_id) return { sent: false, reason: 'no_recipient' }

      const { resolveChannelConnection } = await import('./channels')
      const conn = await resolveChannelConnection(conversation.location_id, 'instagram', db)
      if (!conn?.access_token) return { sent: false, reason: 'no_connection' }

      const { sendInstagramMessage } = await import('./instagram')
      const result = await sendInstagramMessage(conversation.ig_user_id, text, {
        connection: { access_token: conn.access_token },
      })
      const { error: insertError } = await db.from('instagram_messages').insert({
        conversation_id: conversationId,
        contact_id: conversation.contact_id || null,
        location_id: conversation.location_id,
        ig_message_id: result?.messageId || null,
        direction: 'outbound',
        message_type: 'text',
        body: text,
        status: 'sent',
        source: 'agent',
        sent_at: new Date().toISOString(),
      })
      if (insertError) console.error('[agent][notify] failed to record Instagram confirmation (history will be incomplete):', insertError.message)
      return { sent: true }
    }

    return { sent: false, reason: 'unknown_channel' }
  } catch (e) {
    console.warn(`[agent][notify] thread message failed: ${e?.message || e}`)
    return { sent: false, reason: 'send_error' }
  }
}
