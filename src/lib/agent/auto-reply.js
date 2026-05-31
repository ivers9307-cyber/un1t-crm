// RADAR-AGENT.0 — customer-agent auto-reply orchestrator (IO).
//
// Called best-effort from the WhatsApp inbound webhook AFTER the inbound
// message has been persisted. Owns the network + DB side; all decisions
// and formatting are the pure helpers in core.js / prompt.js.
//
// Safety posture (Phase 0):
//   - Gated OFF by default. Only runs if locations.settings.customer_agent
//     enables it (globally) or test-mode allow-lists this number.
//   - No tools, no account actions. Answers from knowledge or hands off.
//   - On handoff: sends a holding message, flips the conversation's
//     agent_active to false (so it stays with a human), notifies staff.
//   - Never throws — the webhook wraps the call too, but we double up.

import { sendTextMessage } from '@/lib/whatsapp'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'
import { buildCustomerSystemPrompt } from './prompt'
import {
  shouldAgentReply,
  formatHistoryForClaude,
  parseAgentResponse,
  AGENT_MESSAGE_SOURCE,
  DEFAULT_HOLDING_MESSAGE,
} from './core'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const AGENT_MODEL = 'claude-sonnet-4-20250514'
const MAX_HISTORY = 20

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {object} ctx
 * @param {string} ctx.conversationId
 * @param {string} ctx.locationId
 * @param {string} ctx.senderPhone
 * @param {string|null} ctx.contactId
 * @param {string} ctx.messageType
 * @param {string} ctx.body
 */
export async function maybeAutoReply(db, ctx) {
  const { conversationId, locationId, senderPhone, contactId, messageType, body } = ctx

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { handled: false, reason: 'no_api_key' }
  if (!conversationId || !locationId) return { handled: false, reason: 'missing_context' }

  // Location settings + name.
  const { data: loc } = await db.from('locations')
    .select('name, settings')
    .eq('id', locationId)
    .single()
  const settings = loc?.settings?.customer_agent || null

  // Per-conversation kill switch.
  const { data: conv } = await db.from('whatsapp_conversations')
    .select('agent_active')
    .eq('id', conversationId)
    .single()

  const decision = shouldAgentReply({
    settings,
    conversation: conv,
    message: { type: messageType, body },
    senderPhone,
    now: new Date(),
  })
  if (!decision.reply) return { handled: false, reason: decision.reason }

  // Knowledge for this location.
  const { data: knowledge } = await db.from('agent_knowledge')
    .select('category, title, content, enabled, sort_order')
    .eq('location_id', locationId)
    .eq('enabled', true)
    .order('sort_order', { ascending: true })

  // Conversation history (ascending) — includes the just-saved inbound.
  const { data: history } = await db.from('whatsapp_messages')
    .select('direction, body, message_type, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(MAX_HISTORY * 2)

  const systemPrompt = buildCustomerSystemPrompt({
    businessName: 'UN1T',
    locationName: loc?.name || null,
    tone: settings?.tone || null,
    extraRules: settings?.extra_rules || null,
    knowledge: knowledge || [],
    today: new Date().toISOString().slice(0, 10),
  })

  const messages = formatHistoryForClaude(history || [], { maxMessages: MAX_HISTORY })
  if (messages.length === 0) return { handled: false, reason: 'no_history' }

  // Call the model (buffered; no tools in Phase 0).
  let modelText = ''
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: AGENT_MODEL,
        max_tokens: 600,
        system: systemPrompt,
        messages,
      }),
    })
    if (!res.ok) {
      console.error('[radar-agent] Anthropic error', res.status, await res.text().catch(() => ''))
      return { handled: false, reason: 'model_error' }
    }
    const data = await res.json()
    modelText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
  } catch (err) {
    console.error('[radar-agent] model call failed', err?.message)
    return { handled: false, reason: 'model_exception' }
  }

  const parsed = parseAgentResponse(modelText)

  if (parsed.action === 'handoff') {
    await handoff(db, { conversationId, locationId, senderPhone, contactId, reason: parsed.reason, settings })
    return { handled: true, action: 'handoff', reason: parsed.reason }
  }

  await sendAndLog(db, {
    conversationId, locationId, senderPhone, contactId,
    text: parsed.text,
  })
  return { handled: true, action: 'reply' }
}

// Send an agent reply + persist it + update the conversation.
async function sendAndLog(db, { conversationId, locationId, senderPhone, contactId, text }) {
  let waMessageId = null
  try {
    const r = await sendTextMessage(senderPhone, text, { locationId })
    waMessageId = r?.messageId || null
  } catch (err) {
    console.error('[radar-agent] send failed', err?.message)
    return
  }

  const now = new Date().toISOString()
  await db.from('whatsapp_messages').insert({
    conversation_id: conversationId,
    contact_id: contactId || null,
    location_id: locationId,
    wa_message_id: waMessageId,
    direction: 'outbound',
    message_type: 'text',
    body: text,
    status: 'sent',
    source: AGENT_MESSAGE_SOURCE,
    sent_at: now,
  })

  await db.from('whatsapp_conversations').update({
    last_message_at: now,
    last_message_direction: 'outbound',
    last_message_preview: text.substring(0, 100),
    agent_last_reply_at: now,
  }).eq('id', conversationId)
}

// Escalate: holding message to the customer, stop the agent on this
// thread, notify staff.
async function handoff(db, { conversationId, locationId, senderPhone, contactId, reason, settings }) {
  const holding = (settings?.holding_message || '').trim() || DEFAULT_HOLDING_MESSAGE

  // Stop the agent on this conversation (durable; survives restarts).
  const now = new Date().toISOString()
  await db.from('whatsapp_conversations').update({
    agent_active: false,
    agent_handed_off_at: now,
  }).eq('id', conversationId)

  // Send the customer a holding message (best-effort).
  try {
    const r = await sendTextMessage(senderPhone, holding, { locationId })
    await db.from('whatsapp_messages').insert({
      conversation_id: conversationId,
      contact_id: contactId || null,
      location_id: locationId,
      wa_message_id: r?.messageId || null,
      direction: 'outbound',
      message_type: 'text',
      body: holding,
      status: 'sent',
      source: AGENT_MESSAGE_SOURCE,
      sent_at: now,
    })
    await db.from('whatsapp_conversations').update({
      last_message_at: now,
      last_message_direction: 'outbound',
      last_message_preview: holding.substring(0, 100),
    }).eq('id', conversationId)
  } catch (err) {
    console.error('[radar-agent] holding-message send failed', err?.message)
  }

  // Notify staff that a thread needs a human.
  try {
    await sendPushToRolesAtLocation(locationId, MANAGER_ROLES, {
      title: 'WhatsApp · needs a human',
      body: `Agent handed off: ${reason || 'see conversation'}`,
      category: 'whatsapp',
      data: { type: 'whatsapp_agent_handoff', conversation_id: conversationId },
    })
  } catch (err) {
    console.error('[radar-agent] handoff push failed', err?.message)
  }
}
