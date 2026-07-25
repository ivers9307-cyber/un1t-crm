// C2 — instant greeting when a user opens the chat without typing
// (messages[0].type === 'request_welcome', typically a click-to-WhatsApp ad
// lead). No Claude call — a configured (operator-editable) text greeting,
// gated by the same customer_agent switches as the auto-reply so a disabled
// or test-mode agent never greets strangers.
import { sendTextMessage } from '@/lib/whatsapp'
import { phoneMatchesAllowlist, isWithinQuietHours, resolveAgentGate, AGENT_MESSAGE_SOURCE } from './core'

export const DEFAULT_WELCOME_GREETING =
  "Hi! 👋 Welcome to UN1T. I'm Mia, the studio's assistant — ask me anything, or tell me if you'd like to book a free class or a consultation."

// Pure gate: mirrors shouldAgentReply's on-duty rules (enabled/test allowlist/
// quiet hours) without the per-conversation state (a request_welcome thread is
// brand new by definition).
export function shouldSendWelcome({ settings, senderPhone, now = new Date() }) {
  const s = settings || {}
  // Shared combine (core.resolveAgentGate) so this gate can't drift from
  // shouldAgentReply — enabled+test_mode is live for everyone on both.
  const { enabled, testMode } = resolveAgentGate(s)
  if (!enabled && !testMode) return { send: false, reason: 'disabled' }
  if (!enabled && testMode && !phoneMatchesAllowlist(senderPhone, s.test_phones)) {
    return { send: false, reason: 'not_in_test_allowlist' }
  }
  if (isWithinQuietHours(now, s.quiet_hours)) return { send: false, reason: 'quiet_hours' }
  return { send: true }
}

/** Send the greeting + log it to the thread. Best-effort; never throws. */
export async function maybeSendWelcomeGreeting(db, { conversationId, locationId, senderPhone, contactId }) {
  try {
    if (!conversationId || !locationId || !senderPhone) return { sent: false, reason: 'missing_context' }
    const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).single()
    const settings = loc?.settings?.customer_agent || null
    const gate = shouldSendWelcome({ settings, senderPhone })
    if (!gate.send) return { sent: false, reason: gate.reason }

    // Idempotency: greet a thread once — skip if ANY outbound already exists.
    const { count } = await db.from('whatsapp_messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .eq('direction', 'outbound')
    if ((count || 0) > 0) return { sent: false, reason: 'already_greeted' }

    const text = (settings?.welcome_greeting || '').trim() || DEFAULT_WELCOME_GREETING
    const result = await sendTextMessage(senderPhone, text, { locationId })
    await db.from('whatsapp_messages').insert({
      conversation_id: conversationId,
      contact_id: contactId || null,
      location_id: locationId,
      wa_message_id: result.messageId,
      direction: 'outbound',
      message_type: 'text',
      body: text,
      status: 'sent',
      source: AGENT_MESSAGE_SOURCE,
      sent_at: new Date().toISOString(),
    })
    return { sent: true }
  } catch (e) {
    console.error('[wa-welcome] greeting failed:', e?.message)
    return { sent: false, reason: 'exception' }
  }
}
